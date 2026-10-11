
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
          facingMode,
          width: { ideal: 1080 },
          height: { ideal: 1920 }
        },
        audio: true
      });

      preview.srcObject = cameraStream;
      preview.hidden = false;
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
      preview.srcObject = null;
    }
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

    if (!cameraStream || !cameraStream.getVideoTracks().some(t => t.readyState === "live")) {
      message("Сначала разрешите доступ к камере.");
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

      // Останавливаем предварительный просмотр.
      // На live.html камера будет подключена к LiveKit заново.
      stopCamera();

      window.location.href =
        "/live.html?room=" + encodeURIComponent(roomName);
    } catch (error) {
      message("Не удалось запустить эфир: " + error.message);
      startButton.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function switchCamera() {
    facingMode = facingMode === "user" ? "environment" : "user";
    await startCamera();
  }

  async function logout() {
    stopCamera();

    try {
      await api("/api/host/logout", { method: "POST" });
      showLogin();
      message("Вы вышли.");
    } catch (error) {
      message("Ошибка выхода: " + error.message);
    }
  }

  loginForm.addEventListener("submit", login);
  streamForm.addEventListener("submit", startStream);
  cameraButton?.addEventListener("click", switchCamera);
  logoutButton?.addEventListener("click", logout);

  checkLogin();

  window.addEventListener("beforeunload", stopCamera);
})();
