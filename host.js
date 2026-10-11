
(() => {
  "use strict";

  const LIVEKIT_CDN =
    "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";

  let room = null;
  let busy = false;
  let currentRoomName = "";

  const $ = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  };

  const titleInput = $(
    "#streamTitleInput",
    "#streamTitle",
    "#title",
    'input[name="title"]',
    'input[placeholder*="название" i]'
  );

  const startButton = $(
    "#startStream",
    "#startBtn",
    "#startStreamBtn",
    "#startButton",
    'button[data-action="start"]'
  );

  const stopButton = $(
    "#stopStream",
    "#stopBtn",
    "#stopStreamBtn",
    "#stopButton",
    'button[data-action="stop"]'
  );

  const statusElement = $(
    "#hostStatus",
    "#status",
    "#streamStatus"
  );

  const watchLink = $(
    "#watchLink",
    "#liveLink",
    "#streamLink"
  );

  const videoElement = $(
    "#hostVideo",
    "#localVideo",
    "#preview",
    "video"
  );

  function status(message) {
    if (statusElement) statusElement.textContent = message;
    console.log("[Y-FETISH LIVE]", message);
  }

  async function loadLiveKit() {
    if (window.LivekitClient || window.LiveKit) {
      return window.LivekitClient || window.LiveKit;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = LIVEKIT_CDN;
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("Не удалось загрузить LiveKit"));
      document.head.appendChild(script);
    });

    const sdk = window.LivekitClient || window.LiveKit;

    if (!sdk) {
      throw new Error("Библиотека LiveKit не найдена");
    }

    return sdk;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Ошибка сервера: ${response.status}`);
    }

    return data;
  }

  async function startStream() {
    if (busy || room) return;

    const title = titleInput?.value.trim();

    if (!title) {
      status("Сначала введи название эфира");
      titleInput?.focus();
      return;
    }

    busy = true;
    if (startButton) startButton.disabled = true;
    status("Подключаем камеру и запускаем эфир…");

    try {
      const sdk = await loadLiveKit();

      currentRoomName =
        "live-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);

      // Сервер проверяет авторизацию ведущего.
      const startData = await api("/api/streams/start", {
        method: "POST",
        body: JSON.stringify({
          title,
          roomName: currentRoomName
        })
      });

      const roomName =
        startData.roomName ||
        startData.stream?.room_name ||
        currentRoomName;

      currentRoomName = roomName;

      const tokenData = await api(
        "/api/livekit/token?roomName=" +
          encodeURIComponent(roomName)
      );

      const token = tokenData.token;
      const serverUrl =
        tokenData.url ||
        tokenData.serverUrl ||
        tokenData.livekitUrl;

      if (!token || !serverUrl) {
        throw new Error(
          "Сервер не вернул LiveKit token и URL. Проверь /api/livekit/token."
        );
      }

      room = new sdk.Room();

      await room.connect(serverUrl, token);

      const tracks = await sdk.createLocalTracks({
        audio: true,
        video: true
      });

      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);

        if (videoElement && track.kind === "video") {
          track.attach(videoElement);
          videoElement.autoplay = true;
          videoElement.muted = true;
          videoElement.playsInline = true;
        }
      }

      const url =
        `${location.origin}/live.html?room=` +
        encodeURIComponent(roomName);

      if (watchLink) {
        watchLink.href = url;
        watchLink.textContent = url;
        watchLink.hidden = false;
      }

      status("Эфир идёт. Ссылка для зрителей готова.");

      if (stopButton) stopButton.disabled = false;
    } catch (error) {
      console.error(error);
      status(error.message || "Не удалось начать эфир");

      if (room) {
        try {
          await room.disconnect();
        } catch {}
        room = null;
      }

      try {
        await api("/api/streams/stop", {
          method: "POST",
          body: JSON.stringify({ roomName: currentRoomName })
        });
      } catch {}

      currentRoomName = "";
    } finally {
      busy = false;
      if (startButton) startButton.disabled = false;
    }
  }

  async function stopStream() {
    if (busy) return;

    busy = true;
    if (stopButton) stopButton.disabled = true;
    status("Останавливаем эфир…");

    const oldRoomName = currentRoomName;

    try {
      if (room) {
        await room.disconnect();
        room = null;
      }

      await api("/api/streams/stop", {
        method: "POST",
        body: JSON.stringify({ roomName: oldRoomName })
      });

      currentRoomName = "";
      status("Эфир завершён");
    } catch (error) {
      status(error.message || "Ошибка остановки эфира");
    } finally {
      busy = false;
      if (startButton) startButton.disabled = false;
    }
  }

  startButton?.addEventListener("click", startStream);
  stopButton?.addEventListener("click", stopStream);

  if (stopButton) stopButton.disabled = true;

  window.addEventListener("beforeunload", () => {
    if (room) room.disconnect();
  });
})();
