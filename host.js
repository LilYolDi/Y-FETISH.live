"use strict";

const $ = (id) => document.getElementById(id);

const SUPABASE_URL = "https://cdyuxiicllnfrwssigsr.supabase.co";
const SUPABASE_KEY = "sb_publishable_VuAtnZ0pGWc4BOsYTLBfeA_1Mb86lw0";

const loginPanel = $("loginPanel");
const studioPanel = $("studioPanel");
const loginForm = $("loginForm");
const passwordInput = $("password");
const loginButton = $("loginButton");
const streamForm = $("streamForm");
const titleInput = $("streamTitle");
const roomInput = $("roomName");
const countryInput = $("streamCountry");
const startButton = $("startButton");
const stopButton = $("stopButton");
const logoutButton = $("logoutButton");
const preview = $("preview");
const statusText = $("status");
const watchLink = $("watchLink");
const cameraButton = $("cameraButton");

let supabaseClient = null;
let currentUser = null;
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

function setStudioVisible(authenticated) {
  if (loginPanel) loginPanel.hidden = authenticated;
  if (studioPanel) studioPanel.hidden = !authenticated;
  document.body.classList.toggle("studio-active", authenticated);
}

async function loadSupabase() {
  if (window.supabase?.createClient) {
    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Не удалось загрузить Supabase"));
    document.head.appendChild(script);
  });

  supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
  );
}

async function getAccessToken() {
  if (!supabaseClient) await loadSupabase();

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;

  const session = data?.session;
  if (!session?.access_token) return null;

  currentUser = session.user;
  return session.access_token;
}

async function apiFetch(url, options = {}) {
  const token = await getAccessToken();

  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
}

async function loadSDK() {
  if (window.LivekitClient) return window.LivekitClient;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Не удалось загрузить LiveKit"));
    document.head.appendChild(script);
  });

  if (!window.LivekitClient) {
    throw new Error("Библиотека LiveKit недоступна");
  }

  return window.LivekitClient;
}

function getCameraTrack() {
  return localTracks.find(track => track.kind === "video") || null;
}

async function prepareCamera() {
  if (previewStarting || getCameraTrack()) return;

  previewStarting = true;
  status("Включаем камеру и микрофон...");

  try {
    sdk = await loadSDK();

    localTracks = await sdk.createLocalTracks({
      audio: true,
      video: {
        resolution: sdk.VideoPresets.h720.resolution,
        facingMode: currentFacingMode
      }
    });

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
    console.error("Camera preview:", error);
    status(error.message || "Не удалось включить камеру.");
  } finally {
    previewStarting = false;
  }
}

async function checkLogin() {
  try {
    await loadSupabase();

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (!data?.session) {
      currentUser = null;
      setStudioVisible(false);
      status("Сначала войди в свой аккаунт.");
      return;
    }

    currentUser = data.session.user;

    const response = await apiFetch("/api/host/status");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось проверить аккаунт");
    }

    setStudioVisible(true);
    status(
      `Вход выполнен${result.nickname ? ": " + result.nickname : ""}. Подготавливаем камеру...`
    );

    await prepareCamera();
  } catch (error) {
    console.error("Auth check:", error);
    setStudioVisible(false);
    status(error.message || "Не удалось проверить вход.");
  }
}

/* Старая форма пароля больше не используется */

if (loginForm) {
  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    status("Войди через страницу аккаунта.");

    if (passwordInput) passwordInput.value = "";

    location.href = "/login.html";
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
    const cameras = devices.filter(device => device.kind === "videoinput");

    if (cameras.length < 2) {
      currentFacingMode =
        currentFacingMode === "user" ? "environment" : "user";

      if (typeof cameraTrack.restartTrack !== "function") {
        status("Переключение камеры не поддерживается.");
        return;
      }

      await cameraTrack.restartTrack({ facingMode: currentFacingMode });
    } else {
      const currentId =
        cameraTrack.mediaStreamTrack.getSettings().deviceId;
      const index = cameras.findIndex(device => device.deviceId === currentId);
      const nextCamera = cameras[(index + 1) % cameras.length];

      if (typeof cameraTrack.switchCamera === "function") {
        await cameraTrack.switchCamera(nextCamera.deviceId);
      } else if (typeof cameraTrack.restartTrack === "function") {
        await cameraTrack.restartTrack({ deviceId: nextCamera.deviceId });
      } else {
        status("Переключение камеры не поддерживается.");
        return;
      }
    }

    if (preview) {
      preview.srcObject = new MediaStream([
        cameraTrack.mediaStreamTrack
      ]);
      await preview.play().catch(() => {});
    }

    status("Камера переключена.");
  } catch (error) {
    console.error("Camera switch:", error);
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
  if (!activeRoomName || !room) return;

  try {
    const response = await apiFetch("/api/streams/heartbeat", {
      method: "POST",
      body: JSON.stringify({ roomName: activeRoomName })
    });

    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      stopHeartbeat();
      status("Сервер завершил сессию эфира. Проверь вход.");
    }
  } catch (error) {
    console.error("Heartbeat:", error);
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
      const response = await apiFetch("/api/streams/stop", {
        method: "POST",
        body: JSON.stringify({ roomName: roomNameToStop })
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        console.error("Stream stop:", result.error || response.status);
      }
    }
  } catch (error) {
    console.error("Stop request:", error);
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

  localTracks.forEach(track => {
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

  if (watchLink) watchLink.hidden = true;

  isStopping = false;
  status(message);
}

if (streamForm) {
  streamForm.addEventListener("submit", async event => {
    event.preventDefault();

    if (room || isStopping || isStarting) return;

    const title = titleInput ? titleInput.value.trim() : "";
    const baseRoomName = roomInput ? roomInput.value.trim() : "live";
    const country = countryInput ? countryInput.value : "Украина";

    if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(baseRoomName)) {
      status("Укажи название и корректное имя комнаты.");
      return;
    }

    isStarting = true;
    if (startButton) startButton.disabled = true;

    status("Проверяем аккаунт...");

    let streamRegistered = false;

    try {
      const accessToken = await getAccessToken();

      if (!accessToken || !currentUser) {
        throw new Error("Войди в свой аккаунт на странице входа.");
      }

      /*
       * ИСПРАВЛЕНИЕ:
       * Каждому запуску присваивается новое имя комнаты.
       * Даже если старый эфир завершён, уникальное ограничение
       * live_streams_room_name_key не будет мешать новому запуску.
       */

      const baseName = baseRoomName.slice(0, 65);
      const userSuffix = currentUser.id.replace(/-/g, "").slice(0, 12);
      const randomSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

      const roomName = `${baseName}_${userSuffix}_${randomSuffix}`;

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

      status("Регистрируем эфир...");

      const saveResponse = await apiFetch("/api/streams/start", {
        method: "POST",
        body: JSON.stringify({ title, roomName, country })
      });

      const saved = await saveResponse.json();

      if (!saveResponse.ok) {
        throw new Error(saved.error || "Не удалось зарегистрировать эфир");
      }

      streamRegistered = true;
      activeRoomName = roomName;

      status("Подключаемся к LiveKit...");

      const tokenResponse = await apiFetch(
        `/api/livekit/token?roomName=${encodeURIComponent(roomName)}`
      );

      const credentials = await tokenResponse.json();

      if (!tokenResponse.ok) {
        throw new Error(
          credentials.error || "Не удалось получить токен LiveKit"
        );
      }

      const newRoom = new sdk.Room({
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
        await stopStream(error.message || "Не удалось запустить эфир.");
      } else {
        stopHeartbeat();

        if (room) {
          try {
            await room.disconnect();
          } catch {}
        }

        room = null;
        activeRoomName = "";

        localTracks.forEach(track => {
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

        status(error.message || "Не удалось начать эфир.");
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
      if (supabaseClient) {
        await supabaseClient.auth.signOut();
      }
    } catch (error) {
      console.error("Logout:", error);
    }

    currentUser = null;

    localTracks.forEach(track => {
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
    status("Ты вышел из аккаунта.");
    location.href = "/login.html";
  });
}

window.addEventListener("beforeunload", () => {
  stopHeartbeat();

  if (room) room.disconnect();

  localTracks.forEach(track => {
    try {
      track.stop();
    } catch {}
  });
});

checkLogin();
