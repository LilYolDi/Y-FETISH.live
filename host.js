
(() => {
  "use strict";

  const LIVEKIT_CDN =
    "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";

  const $ = (selector) => document.querySelector(selector);

  const loginForm = $("#loginForm");
  const passwordInput = $("#password");
  const loginButton = $("#loginButton");
  const loginPanel = $("#loginPanel");
  const studioPanel = $("#studioPanel");

  const streamForm = $("#streamForm");
  const titleInput = $("#streamTitle");
  const startButton = $("#startButton");
  const stopButton = $("#stopButton");
  const cameraButton = $("#cameraButton");
  const logoutButton = $("#logoutButton");

  const preview = $("#preview");
  const watchLink = $("#watchLink");
  const statusElement = $("#status");

  let room = null;
  let localTracks = [];
  let currentRoomName = "";
  let busy = false;
  let cameraFacing = "user";

  function setStatus(message) {
    if (statusElement) statusElement.textContent = message;
  }

  function showLogin() {
    if (loginPanel) loginPanel.hidden = false;
    if (studioPanel) studioPanel.hidden = true;
  }

  function showStudio() {
    if (loginPanel) loginPanel.hidden = true;
    if (studioPanel) studioPanel.hidden = false;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || data.message || `Ошибка HTTP ${response.status}`);
    }

    return data;
  }

  function loadLiveKit() {
    if (window.LivekitClient || window.LiveKit) {
      return Promise.resolve(window.LivekitClient || window.LiveKit);
    }

    return new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-livekit-host="true"]'
      );

      const script = existing || document.createElement("script");
      script.src = LIVEKIT_CDN;
      script.async = true;
      script.dataset.livekitHost = "true";

      script.onload = () => {
        const sdk = window.LivekitClient || window.LiveKit;
        if (sdk) resolve(sdk);
        else reject(new Error("LiveKit загрузился, но SDK недоступен."));
      };

      script.onerror = () => reject(new Error("Не удалось загрузить LiveKit."));

      if (!existing) document.head.appendChild(script);
    });
  }

  async function checkLogin() {
    try {
      const result = await api("/api/host/status");

      if (result.authenticated) {
        showStudio();
        setStatus("Вы вошли как ведущий.");
      } else {
        showLogin();
      }
    } catch (error) {
      showLogin();
      setStatus("Не удалось проверить вход: " + error.message);
    }
  }

  async function login(event) {
    event.preventDefault();

    if (!passwordInput || !loginButton) return;

    const password = passwordInput.value;

    if (!password) {
      setStatus("Введите пароль.");
      return;
    }

    loginButton.disabled = true;
    setStatus("Проверка пароля...");

    try {
      await api("/api/host/login", {
        method: "POST",
        body: JSON.stringify({ password })
      });

      passwordInput.value = "";
      showStudio();
      setStatus("Вход выполнен. Можно начинать эфир.");
    } catch (error) {
      setStatus("Ошибка входа: " + error.message);
    } finally {
      loginButton.disabled = false;
    }
  }

  async function startStream(event) {
    if (event) event.preventDefault();
    if (busy) return;

    const title = titleInput?.value.trim();

    if (!title) {
      setStatus("Введите название эфира.");
      titleInput?.focus();
      return;
    }

    busy = true;
    if (startButton) startButton.disabled = true;

    currentRoomName =
      "live-" + Date.now().toString(36) +
      "-" + Math.random().toString(36).slice(2, 7);

    let streamCreated = false;

    try {
      setStatus("Подключение к серверу...");

      const sdk = await loadLiveKit();

      await api("/api/streams/start", {
        method: "POST",
        body: JSON.stringify({
          title,
          roomName: currentRoomName
        })
      });

      streamCreated = true;

      const tokenData = await api(
        "/api/livekit/token?roomName=" +
        encodeURIComponent(currentRoomName)
      );

      const serverUrl = tokenData.url || tokenData.serverUrl;
      const token = tokenData.token;

      if (!serverUrl || !token) {
        throw new Error("Сервер не вернул адрес LiveKit или токен.");
      }

      room = new sdk.Room();

      await room.connect(serverUrl, token);

      setStatus("Включение камеры и микрофона...");

      localTracks = await sdk.createLocalTracks({
        audio: true,
        video: { facingMode: cameraFacing }
      });

      for (const track of localTracks) {
        await room.localParticipant.publishTrack(track);

        if (track.kind === "video" && preview) {
          track.attach(preview);
        }
      }

      if (preview) preview.hidden = false;

      if (watchLink) {
        watchLink.href =
          "/live.html?room=" + encodeURIComponent(currentRoomName);
        watchLink.textContent = "Открыть эфир";
        watchLink.hidden = false;
      }

      if (stopButton) stopButton.hidden = false;
      if (startButton) startButton.hidden = true;

      setStatus("Эфир запущен!");
    } catch (error) {
      setStatus("Не удалось запустить эфир: " + error.message);

      await disconnectRoom();

      if (streamCreated && currentRoomName) {
        try {
          await api("/api/streams/stop", {
            method: "POST",
            body: JSON.stringify({ roomName: currentRoomName })
          });
        } catch (_) {}
      }
    } finally {
      busy = false;
      if (startButton && !room) startButton.disabled = false;
    }
  }

  async function disconnectRoom() {
    for (const track of localTracks) {
      try {
        track.detach();
        track.stop();
      } catch (_) {}
    }

    localTracks = [];

    if (room) {
      try {
        await room.disconnect();
      } catch (_) {}
    }

    room = null;

    if (preview) {
      preview.pause?.();
      preview.srcObject = null;
      preview.hidden = true;
    }
  }

  async function stopStream() {
    if (busy) return;

    busy = true;
    if (stopButton) stopButton.disabled = true;

    try {
      await disconnectRoom();

      if (currentRoomName) {
        await api("/api/streams/stop", {
          method: "POST",
          body: JSON.stringify({ roomName: currentRoomName })
        });
      }

      if (watchLink) watchLink.hidden = true;
      if (stopButton) stopButton.hidden = true;
      if (startButton) {
        startButton.hidden = false;
        startButton.disabled = false;
      }

      currentRoomName = "";
      setStatus("Эфир завершён.");
    } catch (error) {
      setStatus("Ошибка завершения эфира: " + error.message);
    } finally {
      busy = false;
      if (stopButton) stopButton.disabled = false;
    }
  }

  async function switchCamera() {
    if (!room || busy) return;

    const sdk = await loadLiveKit();
    const createVideoTrack = sdk.createLocalVideoTrack;

    if (!createVideoTrack) {
      setStatus("Переключение камеры не поддерживается этой версией LiveKit.");
      return;
    }

    busy = true;
    if (cameraButton) cameraButton.disabled = true;

    try {
      const oldTrack = localTracks.find((track) => track.kind === "video");

      cameraFacing = cameraFacing === "user" ? "environment" : "user";

      if (oldTrack) {
        await room.localParticipant.unpublishTrack(oldTrack);
        oldTrack.detach();
        oldTrack.stop();
        localTracks = localTracks.filter((track) => track !== oldTrack);
      }

      const newTrack = await createVideoTrack({
        facingMode: cameraFacing
      });

      await room.localParticipant.publishTrack(newTrack);
      localTracks.push(newTrack);

      if (preview) {
        newTrack.attach(preview);
        preview.hidden = false;
      }

      setStatus("Камера переключена.");
    } catch (error) {
      cameraFacing = cameraFacing === "user" ? "environment" : "user";
      setStatus("Не удалось переключить камеру: " + error.message);
    } finally {
      busy = false;
      if (cameraButton) cameraButton.disabled = false;
    }
  }

  async function logout() {
    if (busy) return;

    try {
      if (room && currentRoomName) {
        await stopStream();
      } else {
        await disconnectRoom();
      }
    } catch (_) {}

    try {
      await api("/api/host/logout", { method: "POST" });
      showLogin();
      setStatus("Вы вышли из аккаунта ведущего.");
    } catch (error) {
      setStatus("Ошибка выхода: " + error.message);
    }
  }

  loginForm?.addEventListener("submit", login);
  streamForm?.addEventListener("submit", startStream);
  startButton?.addEventListener("click", startStream);
  stopButton?.addEventListener("click", stopStream);
  cameraButton?.addEventListener("click", switchCamera);
  logoutButton?.addEventListener("click", logout);

  checkLogin();
})();
