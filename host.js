"use strict";

const $ = (id) => document.getElementById(id);

const loginPanel = $("loginPanel");
const studioPanel = $("studioPanel");
const loginForm = $("loginForm");
const passwordInput = $("password");
const loginButton = $("loginButton");
const streamForm = $("streamForm");
const titleInput = $("streamTitle");
const roomInput = $("roomName");
const startButton = $("startButton");
const stopButton = $("stopButton");
const logoutButton = $("logoutButton");
const preview = $("preview");
const statusText = $("status");
const watchLink = $("watchLink");
const cameraButton = $("cameraButton");

let room = null;
let localTracks = [];
let activeRoomName = "";
let sdk = null;
let isStopping = false;
let isStarting = false;
let previewStarting = false;
let currentFacingMode = "user";
let heartbeatTimer = null;

function status(message) {
  if (statusText) statusText.textContent = message;
}

async function loadSDK() {
  if (window.LivekitClient) return window.LivekitClient;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");

    script.src =
      "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";

    script.onload = resolve;
    script.onerror = () =>
      reject(new Error("Не удалось загрузить LiveKit"));

    document.head.appendChild(script);
  });

  if (!window.LivekitClient) {
    throw new Error("Библиотека LiveKit недоступна");
  }

  return window.LivekitClient;
}

function setStudioVisible(authenticated) {
  if (loginPanel) loginPanel.hidden = authenticated;
  if (studioPanel) studioPanel.hidden = !authenticated;

  document.body.classList.toggle("studio-active", authenticated);
}

function getCameraTrack() {
  return localTracks.find((track) => track.kind === "video") || null;
}

async function prepareCamera() {
  if (previewStarting || getCameraTrack()) return;

  previewStarting = true;
  status("Включаем камеру и микрофон...");

  try {
    sdk = await loadSDK();

    const tracks = await sdk.createLocalTracks({
      audio: true,
      video: {
        resolution: sdk.VideoPresets.h720.resolution,
        facingMode: currentFacingMode
      }
    });

    localTracks = tracks;

    const cameraTrack = getCameraTrack();

    if (cameraTrack && preview) {
      preview.srcObject = new MediaStream([
        cameraTrack.mediaStreamTrack
      ]);

      preview.hidden = false;
      await preview.play().catch(() => {});
    }

    status("Камера включена. Введи название и начинай эфир.");
  } catch (error) {
    console.error("Camera preview error:", error);
    status(
      error.message ||
      "Не удалось включить камеру. Проверь разрешения браузера."
    );
  } finally {
    previewStarting = false;
  }
}

async function checkLogin() {
  try {
    const response = await fetch("/api/host/status", {
      credentials: "same-origin",
      cache: "no-store"
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Ошибка проверки входа");
    }

    setStudioVisible(Boolean(result.authenticated));

    if (result.authenticated) {
      status("Вход выполнен. Подготавливаем камеру...");
      await prepareCamera();
    } else {
      status("Войди, чтобы начать.");
    }
  } catch (error) {
    status(error.message || "Не удалось проверить вход. Обнови страницу.");
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (loginButton) loginButton.disabled = true;

    try {
      const response = await fetch("/api/host/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: passwordInput ? passwordInput.value : ""
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Ошибка входа");
      }

      if (passwordInput) passwordInput.value = "";

      setStudioVisible(true);
      status("Вход выполнен. Подготавливаем камеру...");
      await prepareCamera();
    } catch (error) {
      status(error.message || "Ошибка входа");
    } finally {
      if (loginButton) loginButton.disabled = false;
    }
  });
}

async function switchCamera() {
  try {
    sdk = sdk || await loadSDK();

    let cameraTrack = getCameraTrack();

    if (!cameraTrack) {
      await prepareCamera();
      cameraTrack = getCameraTrack();

      if (!cameraTrack) return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(
      (device) => device.kind === "videoinput"
    );

    if (cameras.length < 2) {
      currentFacingMode =
        currentFacingMode === "user" ? "environment" : "user";

      if (typeof cameraTrack.restartTrack === "function") {
        await cameraTrack.restartTrack({
          facingMode: currentFacingMode
        });

        if (preview) {
          preview.srcObject = new MediaStream([
            cameraTrack.mediaStreamTrack
          ]);

          await preview.play().catch(() => {});
        }

        status("Камера переключена.");
      } else {
        status("Вторая камера на устройстве не найдена.");
      }

      return;
    }

    const currentDeviceId =
      cameraTrack.mediaStreamTrack.getSettings().deviceId;

    const currentIndex = cameras.findIndex(
      (device) => device.deviceId === currentDeviceId
    );

    const nextCamera = cameras[(currentIndex + 1) % cameras.length];

    if (typeof cameraTrack.switchCamera === "function") {
      await cameraTrack.switchCamera(nextCamera.deviceId);
    } else if (typeof cameraTrack.restartTrack === "function") {
      await cameraTrack.restartTrack({
        deviceId: nextCamera.deviceId
      });
    } else {
      status("Переключение камеры не поддерживается этим браузером.");
      return;
    }

    if (preview) {
      preview.srcObject = new MediaStream([
        cameraTrack.mediaStreamTrack
      ]);

      await preview.play().catch(() => {});
    }

    status("Камера переключена.");
  } catch (error) {
    console.error("Camera switch error:", error);
    status("Не удалось переключить камеру.");
  }
}

if (cameraButton) {
  cameraButton.addEventListener("click", switchCamera);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function sendHeartbeat() {
  const roomName = activeRoomName;

  if (!roomName || !room) return;

  try {
    const response = await fetch("/api/streams/heartbeat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName })
    });

    if (response.status === 401) {
      stopHeartbeat();
      status("Сессия ведущего завершена. Войди снова.");
      return;
    }

    if (response.status === 404) {
      stopHeartbeat();
      status("Эфир больше не активен на сервере.");
    }
  } catch (error) {
    console.error("Heartbeat error:", error);
  }
}

function startHeartbeat() {
  stopHeartbeat();

  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 15000);
}

async function stopStream(message = "Эфир завершён.") {
  if (isStopping) return;

  isStopping = true;
  stopHeartbeat();

  const roomNameToStop = activeRoomName;
  activeRoomName = "";

  try {
    if (roomNameToStop) {
      const response = await fetch("/api/streams/stop", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName: roomNameToStop
        })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(
          "Ошибка завершения эфира в базе:",
          result.error || response.status
        );
      }
    }
  } catch (error) {
    console.error("Stream stop request:", error);
  }

  const oldRoom = room;
  room = null;

  if (oldRoom) {
    try {
      await oldRoom.disconnect();
    } catch (error) {
      console.error("LiveKit disconnect:", error);
    }
  }

  localTracks.forEach((track) => {
    try {
      track.stop();
    } catch (error) {
      console.error("Track stop:", error);
    }
  });

  localTracks = [];

  if (preview) {
    preview.srcObject = null;
    preview.hidden = true;
  }

  if (stopButton) stopButton.hidden = true;
  if (startButton) {
    startButton.hidden = false;
    startButton.disabled = false;
  }
  if (watchLink) watchLink.hidden = true;

  isStopping = false;
  status(message);
}

if (streamForm) {
  streamForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (room || isStopping || isStarting) return;

    const title = titleInput ? titleInput.value.trim() : "";
    const roomName = roomInput ? roomInput.value.trim() : "";

    if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(roomName)) {
      status("Укажи название и корректное имя комнаты.");
      return;
    }

    isStarting = true;

    if (startButton) startButton.disabled = true;

    status("Подключаемся и запускаем эфир...");

    let newRoom = null;
    let streamRegistered = false;

    try {
      sdk = sdk || await loadSDK();

      if (!localTracks.length) {
        localTracks = await sdk.createLocalTracks({
          audio: true,
          video: {
            resolution: sdk.VideoPresets.h720.resolution,
            facingMode: currentFacingMode
          }
        });
      }

      // Сервер принимает токен через GET с параметром roomName.
      const tokenUrl =
        `/api/livekit/token?roomName=${encodeURIComponent(roomName)}`;

      const tokenResponse = await fetch(tokenUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store"
      });

      const credentials = await tokenResponse.json();

      if (!tokenResponse.ok) {
        throw new Error(
          credentials.error || "Не удалось получить права ведущего"
        );
      }

      newRoom = new sdk.Room({
        adaptiveStream: true,
        dynacast: true
      });

      room = newRoom;

      await newRoom.connect(
        credentials.serverUrl || credentials.url,
        credentials.token
      );

      for (const track of localTracks) {
        await newRoom.localParticipant.publishTrack(track);
      }

      const cameraTrack = getCameraTrack();

      if (cameraTrack && preview) {
        preview.srcObject = new MediaStream([
          cameraTrack.mediaStreamTrack
        ]);

        preview.hidden = false;
        await preview.play().catch(() => {});
      }

      const saveResponse = await fetch("/api/streams/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          roomName
        })
      });

      const saved = await saveResponse.json();

      if (!saveResponse.ok) {
        throw new Error(
          saved.error || "Не удалось зарегистрировать эфир"
        );
      }

      streamRegistered = true;
      activeRoomName = roomName;

      if (watchLink) {
        watchLink.href =
          `/live.html?room=${encodeURIComponent(roomName)}`;
        watchLink.hidden = false;
      }

      if (stopButton) stopButton.hidden = false;
      if (startButton) startButton.hidden = true;

      startHeartbeat();

      status(
        `Эфир запущен: ${title}\n` +
        `Комната: ${roomName}\n` +
        `Ссылка для зрителей: ${location.origin}/live.html?room=${encodeURIComponent(roomName)}`
      );

      newRoom.on(sdk.RoomEvent.Disconnected, () => {
        if (room === newRoom && !isStopping) {
          stopStream("Соединение с эфиром потеряно.");
        }
      });
    } catch (error) {
      console.error("Host stream error:", error);

      if (streamRegistered && activeRoomName) {
        await stopStream(
          error.message || "Не удалось запустить эфир."
        );
      } else {
        stopHeartbeat();

        const failedRoom = room;
        room = null;
        activeRoomName = "";

        if (failedRoom) {
          try {
            await failedRoom.disconnect();
          } catch {}
        }

        localTracks.forEach((track) => {
          try {
            track.stop();
          } catch {}
        });

        localTracks = [];

        if (preview) {
          preview.srcObject = null;
          preview.hidden = true;
        }

        if (stopButton) stopButton.hidden = true;
        if (startButton) {
          startButton.hidden = false;
          startButton.disabled = false;
        }

        status(
          error.message ||
          "Не удалось начать эфир. Проверь разрешения камеры и микрофона."
        );
      }
    } finally {
      isStarting = false;
    }
  });
}

if (stopButton) {
  stopButton.addEventListener("click", async () => {
    await stopStream();
    await prepareCamera();
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await stopStream("Ты вышел из панели ведущего.");

    try {
      await fetch("/api/host/logout", {
        method: "POST",
        credentials: "same-origin"
      });
    } catch (error) {
      console.error("Logout:", error);
    } finally {
      localTracks.forEach((track) => {
        try {
          track.stop();
        } catch {}
      });

      localTracks = [];

      if (preview) {
        preview.srcObject = null;
        preview.hidden = true;
      }

      setStudioVisible(false);
      status("Ты вышел из панели ведущего.");
    }
  });
}

window.addEventListener("beforeunload", () => {
  stopHeartbeat();

  if (room) {
    room.disconnect();
  }

  localTracks.forEach((track) => {
    try {
      track.stop();
    } catch {}
  });
});

checkLogin();
