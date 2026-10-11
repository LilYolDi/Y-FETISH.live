
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

let room = null;
let localTracks = [];
let activeRoomName = "";
let sdk = null;
let isStopping = false;

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

    loginPanel.hidden = Boolean(result.authenticated);
    studioPanel.hidden = !result.authenticated;

    if (result.authenticated) {
      status("Вход выполнен. Можно начинать эфир.");
    }
  } catch (error) {
    status(error.message || "Не удалось проверить вход. Обнови страницу.");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;

  try {
    const response = await fetch("/api/host/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: passwordInput.value
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Ошибка входа");
    }

    passwordInput.value = "";
    loginPanel.hidden = true;
    studioPanel.hidden = false;
    status("Вход выполнен. Можно начинать эфир.");
  } catch (error) {
    status(error.message || "Ошибка входа");
  } finally {
    loginButton.disabled = false;
  }
});

async function stopStream(message = "Эфир завершён.") {
  if (isStopping) return;
  isStopping = true;

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
  if (startButton) startButton.disabled = false;
  if (watchLink) watchLink.hidden = true;

  isStopping = false;
  status(message);
}

streamForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (room || isStopping) return;

  const title = titleInput.value.trim();
  const roomName = roomInput.value.trim();

  if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(roomName)) {
    status("Укажи название и корректное имя комнаты.");
    return;
  }

  startButton.disabled = true;
  status("Запрашиваем доступ к камере и микрофону...");

  try {
    // Получаем защищённый токен ведущего.
    const tokenResponse = await fetch("/api/livekit/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName,
        participantName: title.slice(0, 50),
        isHost: true
      })
    });

    const credentials = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(
        credentials.error || "Не удалось получить права ведущего"
      );
    }

    sdk = await loadSDK();

    // Подключаем ведущего к LiveKit.
    const newRoom = new sdk.Room({
      adaptiveStream: true,
      dynacast: true
    });

    room = newRoom;

    await newRoom.connect(
      credentials.serverUrl,
      credentials.token
    );

    // Запускаем камеру и микрофон.
    const tracks = await sdk.createLocalTracks({
      audio: true,
      video: {
        resolution: sdk.VideoPresets.h720.resolution,
        facingMode: "user"
      }
    });

    localTracks = tracks;

    for (const track of tracks) {
      await newRoom.localParticipant.publishTrack(track);
    }

    const cameraTrack = tracks.find(
      (track) => track.kind === "video"
    );

    if (cameraTrack && preview) {
      preview.srcObject = new MediaStream([
        cameraTrack.mediaStreamTrack
      ]);
      preview.hidden = false;
      await preview.play().catch(() => {});
    }

    // Сохраняем эфир в Supabase.
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

    activeRoomName = roomName;

    if (watchLink) {
      watchLink.href =
        `/live.html?room=${encodeURIComponent(roomName)}`;
      watchLink.hidden = false;
    }

    if (stopButton) stopButton.hidden = false;

    status(
      `Эфир запущен: ${title}\n` +
      `Комната: ${roomName}\n` +
      `Ссылка для зрителей: ${location.origin}/live.html?room=${encodeURIComponent(roomName)}`
    );

    // Если соединение потеряно, завершаем эфир.
    newRoom.on(sdk.RoomEvent.Disconnected, () => {
      if (room === newRoom && !isStopping) {
        stopStream("Соединение с эфиром потеряно.");
      }
    });

  } catch (error) {
    console.error("Host stream error:", error);

    await stopStream(
      error.message ||
      "Не удалось начать эфир. Проверь разрешения камеры и микрофона."
    );
  }
});

stopButton.addEventListener("click", async () => {
  await stopStream();
});

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
    studioPanel.hidden = true;
    loginPanel.hidden = false;
  }
});

window.addEventListener("beforeunload", () => {
  if (room) room.disconnect();

  localTracks.forEach((track) => {
    try {
      track.stop();
    } catch {}
  });
});

checkLogin();
