
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

function status(message) {
  statusText.textContent = message;
}

async function loadSDK() {
  if (window.LivekitClient) return window.LivekitClient;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/livekit-client/dist/livekit-client.umd.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Не удалось загрузить LiveKit"));
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
      credentials: "same-origin"
    });
    const result = await response.json();

    loginPanel.hidden = Boolean(result.authenticated);
    studioPanel.hidden = !result.authenticated;

    if (result.authenticated) {
      status("Вход выполнен. Можно начинать эфир.");
    }
  } catch {
    status("Не удалось проверить вход. Обнови страницу.");
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
      body: JSON.stringify({ password: passwordInput.value })
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
    status(error.message);
  } finally {
    loginButton.disabled = false;
  }
});

async function stopStream(message = "Эфир завершён.") {
  if (room) {
    try {
      await room.disconnect();
    } catch (error) {
      console.error(error);
    }
  }

  room = null;

  localTracks.forEach((track) => {
    try {
      track.stop();
    } catch {}
  });

  localTracks = [];
  preview.srcObject = null;
  preview.hidden = true;
  stopButton.hidden = true;
  startButton.disabled = false;
  watchLink.hidden = true;

  status(message);
}

streamForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (room) return;

  const title = titleInput.value.trim();
  const roomName = roomInput.value.trim();

  if (!title || !/^[A-Za-z0-9_-]{1,80}$/.test(roomName)) {
    status("Укажи название и корректное имя комнаты.");
    return;
  }

  startButton.disabled = true;
  status("Запрашиваем доступ к камере и микрофону...");

  try {
    // Сначала получаем защищённый токен ведущего.
    const response = await fetch("/api/livekit/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName,
        participantName: title.slice(0, 50),
        isHost: true
      })
    });

    const credentials = await response.json();

    if (!response.ok) {
      throw new Error(credentials.error || "Не удалось получить права ведущего");
    }

    sdk = await loadSDK();

    // Подключаем комнату LiveKit.
    room = new sdk.Room({
      adaptiveStream: true,
      dynacast: true
    });

    await room.connect(credentials.serverUrl, credentials.token);

    // Запрашиваем камеру и микрофон и публикуем их в комнате.
    const tracks = await sdk.createLocalTracks({
      audio: true,
      video: {
        resolution: sdk.VideoPresets.h720.resolution,
        facingMode: "user"
      }
    });

    localTracks = tracks;

    for (const track of tracks) {
      await room.localParticipant.publishTrack(track);
    }

    const cameraTrack = tracks.find((track) => track.kind === "video");

    if (cameraTrack) {
      preview.srcObject = new MediaStream([cameraTrack.mediaStreamTrack]);
      preview.hidden = false;
      await preview.play().catch(() => {});
    }

    activeRoomName = roomName;
    watchLink.href = `/live.html?room=${encodeURIComponent(roomName)}`;
    watchLink.hidden = false;
    stopButton.hidden = false;

    status(
      `Эфир запущен: ${title}\n` +
      `Комната: ${roomName}\n` +
      `Ссылка для зрителей: ${location.origin}${watchLink.getAttribute("href")}`
    );

    room.on(sdk.RoomEvent.Disconnected, () => {
      if (room) stopStream("Соединение с эфиром потеряно.");
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
