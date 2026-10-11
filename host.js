(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const loginForm = $("#loginForm");
  const password = $("#password");
  const loginButton = $("#loginButton");
  const loginPanel = $("#loginPanel");
  const studioPanel = $("#studioPanel");
  const streamForm = $("#streamForm");
  const titleInput = $("#streamTitle");
  const startButton = $("#startButton");
  const preview = $("#preview");
  const status = $("#status");
  const cameraButton = $("#cameraButton");
  const logoutButton = $("#logoutButton");

  let cameraStream = null;
  let facingMode = "user";
  let busy = false;
  let activeRoomName = null;
  let heartbeatTimer = null;

  function message(text) {
    if (status) status.textContent = text;
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
      throw new Error(data.error || `Ошибка ${response.status}`);
    }

    return data;
  }

  function showStudio() {
    loginPanel.hidden = true;
    studioPanel.hidden = false;
    document.body.classList.add("studio-active");
    startCamera();
  }

  function showLogin() {
    stopCamera();
    loginPanel.hidden = false;
    studioPanel.hidden = true;
    document.body.classList.remove("studio-active");
  }

  async function startCamera() {
    stopCamera();

    try {
      message("Подключение камеры...");

      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: true
      });

      const videoTrack = cameraStream.getVideoTracks()[0];

      if (videoTrack) {
        const capabilities = videoTrack.getCapabilities?.();

        if (capabilities?.zoom) {
          try {
            await videoTrack.applyConstraints({
              advanced: [{ zoom: capabilities.zoom.min ?? 1 }]
            });
          } catch (_) {}
        }
      }

      preview.srcObject = cameraStream;
      preview.hidden = false;
      preview.style.objectFit = "contain";
      preview.style.transform = "none";

      await preview.play();

      message("Камера готова. Введите название эфира.");
    } catch (error) {
      message("Не удалось включить камеру: " + error.message);
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }

    if (preview) {
      preview.pause();
      preview.srcObject = null;
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    activeRoomName = null;
  }

  async function sendHeartbeat() {
    if (!activeRoomName) return;

    try {
      await api("/api/streams/heartbeat", {
        method: "POST",
        body: JSON.stringify({ roomName: activeRoomName })
      });
    } catch (error) {
      console.warn("Не удалось отправить сигнал эфира:", error.message);
    }
  }

  function startHeartbeat(roomName) {
    stopHeartbeat();
    activeRoomName = roomName;

    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, 15000);
  }

  async function checkLogin() {
    try {
      const result = await api("/api/host/status");

      if (result.authenticated) {
        showStudio();
      } else {
        showLogin();
        message("Войдите как ведущий.");
      }
    } catch (error) {
      showLogin();
      message(error.message);
    }
  }

  async function login(event) {
    event.preventDefault();

    if (busy) return;

    loginButton.disabled = true;
    message("Проверка пароля...");

    try {
      await api("/api/host/login", {
        method: "POST",
        body: JSON.stringify({ password: password.value })
      });

      password.value = "";
      showStudio();
    } catch (error) {
      message("Ошибка входа: " + error.message);
    } finally {
      loginButton.disabled = false;
    }
  }

  async function startStream(event) {
    event.preventDefault();

    if (busy) return;

    const title = titleInput.value.trim();

    if (!title) {
      message("Введите название эфира.");
      titleInput.focus();
      return;
    }

    if (
      !cameraStream ||
      !cameraStream.getVideoTracks().some(
        (track) => track.readyState === "live"
      )
    ) {
      message("Сначала включите камеру.");
      await startCamera();
      return;
    }

    busy = true;
    startButton.disabled = true;

    const roomName =
      "live-" + Date.now().toString(36) +
      "-" + Math.random().toString(36).slice(2, 7);

    try {
      message("Запуск эфира...");

      await api("/api/streams/start", {
        method: "POST",
        body: JSON.stringify({ title, roomName })
      });

      stopCamera();

      // Продолжаем проверять активность, пока ведущий на странице эфира.
      startHeartbeat(roomName);

      window.location.href =
        "/live.html?room=" + encodeURIComponent(roomName);
    } catch (error) {
      stopHeartbeat();
      message("Не удалось запустить эфир: " + error.message);
      startButton.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function switchCamera() {
    if (busy) return;

    facingMode = facingMode === "user" ? "environment" : "user";
    await startCamera();
  }

  async function logout() {
    if (busy) return;

    busy = true;
    stopCamera();

    try {
      await api("/api/host/logout", { method: "POST" });
      showLogin();
      message("Вы вышли.");
    } catch (error) {
      message("Ошибка выхода: " + error.message);
      await startCamera();
    } finally {
      busy = false;
    }
  }

  loginForm?.addEventListener("submit", login);
  streamForm?.addEventListener("submit", startStream);
  cameraButton?.addEventListener("click", switchCamera);
  logoutButton?.addEventListener("click", logout);

  checkLogin();

  window.addEventListener("beforeunload", () => {
    stopCamera();
    stopHeartbeat();
  });
})();
