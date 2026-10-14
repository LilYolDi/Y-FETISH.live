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
const maskSelect = $("maskSelect");

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
let isSwitchingCamera = false;

/* AR pipeline */
let maskCanvas = null;
let maskContext = null;
let canvasStream = null;
let processedVideoTrack = null;
let faceMeshInstance = null;
let faceLandmarks = null;
let renderFrameId = null;
let faceMeshBusy = false;
let faceMeshLoading = false;
let lastFaceMeshTime = 0;
let maskLoadPromise = null;

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
    script.onerror = () =>
      reject(new Error("Не удалось загрузить Supabase"));
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
    script.onerror = () =>
      reject(new Error("Не удалось загрузить LiveKit"));
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

/* Загрузка MediaPipe Face Mesh только при выборе маски */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(s => s.src === src);

    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
      } else {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => {
          reject(new Error("Не удалось загрузить библиотеку масок"));
        }, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () =>
      reject(new Error("Не удалось загрузить библиотеку масок"));
    document.head.appendChild(script);
  });
}

async function loadFaceMesh() {
  if (faceMeshInstance) return faceMeshInstance;
  if (maskLoadPromise) return maskLoadPromise;

  maskLoadPromise = (async () => {
    await loadScript(
      "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js"
    );

    if (!window.FaceMesh) {
      throw new Error("Библиотека распознавания лица недоступна");
    }

    const mesh = new window.FaceMesh({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    mesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    mesh.onResults(results => {
      faceLandmarks = results.multiFaceLandmarks?.[0] || null;
    });

    faceMeshInstance = mesh;
    return mesh;
  })();

  try {
    return await maskLoadPromise;
  } catch (error) {
    maskLoadPromise = null;
    throw error;
  }
}

function point(index) {
  if (!faceLandmarks || !maskCanvas) return null;

  const p = faceLandmarks[index];
  if (!p) return null;

  return {
    x: p.x * maskCanvas.width,
    y: p.y * maskCanvas.height
  };
}

function drawCatMask(ctx) {
  const left = point(234);
  const right = point(454);
  const forehead = point(10);
  const nose = point(1);
  const chin = point(152);

  if (!left || !right || !forehead || !nose || !chin) return;

  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (!Number.isFinite(width) || width < 10) return;

  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const earHeight = width * 0.24;
  const earWidth = width * 0.22;

  ctx.save();
  ctx.translate(forehead.x, forehead.y + width * 0.04);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.moveTo(-width * 0.34, 0);
  ctx.lineTo(-width * 0.31 - earWidth * 0.15, -earHeight);
  ctx.lineTo(-width * 0.13, 0);
  ctx.closePath();
  ctx.fillStyle = "#202020";
  ctx.fill();
  ctx.lineWidth = Math.max(2, width * 0.018);
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-width * 0.30, -earHeight * 0.22);
  ctx.lineTo(-width * 0.30 - earWidth * 0.08, -earHeight * 0.78);
  ctx.lineTo(-width * 0.19, -earHeight * 0.18);
  ctx.closePath();
  ctx.fillStyle = "#ff8297";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(width * 0.13, 0);
  ctx.lineTo(width * 0.31 + earWidth * 0.15, -earHeight);
  ctx.lineTo(width * 0.34, 0);
  ctx.closePath();
  ctx.fillStyle = "#202020";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(width * 0.19, -earHeight * 0.18);
  ctx.lineTo(width * 0.30 + earWidth * 0.08, -earHeight * 0.78);
  ctx.lineTo(width * 0.30, -earHeight * 0.22);
  ctx.closePath();
  ctx.fillStyle = "#ff8297";
  ctx.fill();

  ctx.restore();

  const noseSize = width * 0.045;
  ctx.beginPath();
  ctx.moveTo(nose.x - noseSize, nose.y - noseSize * 0.3);
  ctx.lineTo(nose.x + noseSize, nose.y - noseSize * 0.3);
  ctx.lineTo(nose.x, nose.y + noseSize * 0.7);
  ctx.closePath();
  ctx.fillStyle = "#ff7892";
  ctx.fill();
  ctx.strokeStyle = "#642536";
  ctx.lineWidth = Math.max(1, width * 0.006);
  ctx.stroke();

  const whiskerY = nose.y + noseSize * 0.5;
  ctx.beginPath();
  ctx.moveTo(nose.x - width * 0.025, whiskerY);
  ctx.lineTo(nose.x - width * 0.30, whiskerY - width * 0.055);
  ctx.moveTo(nose.x - width * 0.025, whiskerY + width * 0.025);
  ctx.lineTo(nose.x - width * 0.32, whiskerY + width * 0.045);
  ctx.moveTo(nose.x + width * 0.025, whiskerY);
  ctx.lineTo(nose.x + width * 0.30, whiskerY - width * 0.055);
  ctx.moveTo(nose.x + width * 0.025, whiskerY + width * 0.025);
  ctx.lineTo(nose.x + width * 0.32, whiskerY + width * 0.045);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(1.5, width * 0.009);
  ctx.stroke();
}

/* Увеличенные очки: закрывают оба глаза и область вокруг них */
function drawGlasses(ctx) {
  const leftOuter = point(33);
  const leftInner = point(133);
  const rightInner = point(362);
  const rightOuter = point(263);
  const nose = point(1);

  if (!leftOuter || !leftInner || !rightInner || !rightOuter || !nose) {
    return;
  }

  const width = Math.hypot(
    rightOuter.x - leftOuter.x,
    rightOuter.y - leftOuter.y
  );

  if (!Number.isFinite(width) || width < 10) return;

  const angle = Math.atan2(
    rightOuter.y - leftOuter.y,
    rightOuter.x - leftOuter.x
  );

  ctx.save();
  ctx.translate(nose.x, nose.y - width * 0.045);
  ctx.rotate(angle);

  const lensWidth = width * 0.43;
  const lensHeight = width * 0.29;
  const gap = width * 0.025;
  const centerOffset = lensWidth / 2 + gap / 2;

  ctx.fillStyle = "rgba(12, 15, 24, 0.96)";
  ctx.strokeStyle = "#08090d";
  ctx.lineWidth = Math.max(3, width * 0.022);

  for (const side of [-1, 1]) {
    const x = side * centerOffset;

    ctx.beginPath();

    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(
        x - lensWidth / 2,
        -lensHeight / 2,
        lensWidth,
        lensHeight,
        lensHeight * 0.22
      );
    } else {
      ctx.rect(
        x - lensWidth / 2,
        -lensHeight / 2,
        lensWidth,
        lensHeight
      );
    }

    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - lensWidth * 0.30, -lensHeight * 0.25);
    ctx.lineTo(x - lensWidth * 0.08, -lensHeight * 0.25);
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = Math.max(1.5, width * 0.009);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(-gap / 2, 0);
  ctx.lineTo(gap / 2, 0);

  ctx.moveTo(-lensWidth - gap / 2, -lensHeight * 0.12);
  ctx.lineTo(-width * 0.52, -lensHeight * 0.05);

  ctx.moveTo(lensWidth + gap / 2, -lensHeight * 0.12);
  ctx.lineTo(width * 0.52, -lensHeight * 0.05);

  ctx.strokeStyle = "#08090d";
  ctx.lineWidth = Math.max(3, width * 0.022);
  ctx.stroke();

  ctx.restore();
}

function drawCrown(ctx) {
  const left = point(234);
  const right = point(454);
  const forehead = point(10);

  if (!left || !right || !forehead) return;

  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 10) return;

  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const crownWidth = width * 0.58;
  const crownHeight = width * 0.22;

  ctx.save();
  ctx.translate(forehead.x, forehead.y + width * 0.015);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.moveTo(-crownWidth / 2, 0);
  ctx.lineTo(-crownWidth / 2, -crownHeight * 0.72);
  ctx.lineTo(-crownWidth * 0.23, -crownHeight * 0.35);
  ctx.lineTo(0, -crownHeight);
  ctx.lineTo(crownWidth * 0.23, -crownHeight * 0.35);
  ctx.lineTo(crownWidth / 2, -crownHeight * 0.72);
  ctx.lineTo(crownWidth / 2, 0);
  ctx.closePath();

  ctx.fillStyle = "#ffcc29";
  ctx.fill();
  ctx.lineWidth = Math.max(2, width * 0.014);
  ctx.strokeStyle = "#fff1a6";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, -crownHeight * 0.53, width * 0.025, 0, Math.PI * 2);
  ctx.fillStyle = "#e21b2d";
  ctx.fill();

  ctx.restore();
}

function drawSelectedMask() {
  if (!maskContext || !maskCanvas || !faceLandmarks) return;

  const selected = maskSelect?.value || "none";

  if (selected === "cat") drawCatMask(maskContext);
  if (selected === "glasses") drawGlasses(maskContext);
  if (selected === "crown") drawCrown(maskContext);
}

function renderFrame() {
  if (!preview || !maskCanvas || !maskContext) return;

  if (preview.readyState >= 2 && preview.videoWidth > 0) {
    if (
      maskCanvas.width !== preview.videoWidth ||
      maskCanvas.height !== preview.videoHeight
    ) {
      maskCanvas.width = preview.videoWidth;
      maskCanvas.height = preview.videoHeight;
    }

    maskContext.drawImage(
      preview,
      0,
      0,
      maskCanvas.width,
      maskCanvas.height
    );

    drawSelectedMask();

    const selected = maskSelect?.value || "none";
    const now = performance.now();

    if (
      selected !== "none" &&
      faceMeshInstance &&
      !faceMeshBusy &&
      now - lastFaceMeshTime > 65
    ) {
      faceMeshBusy = true;
      lastFaceMeshTime = now;

      faceMeshInstance.send({ image: preview })
        .catch(error => console.error("Face Mesh:", error))
        .finally(() => { faceMeshBusy = false; });
    }
  }

  renderFrameId = requestAnimationFrame(renderFrame);
}

async function ensureProcessedVideoTrack() {
  if (processedVideoTrack) return processedVideoTrack;

  sdk = sdk || await loadSDK();

  const cameraTrack = getCameraTrack();
  if (!cameraTrack) {
    throw new Error("Камера не готова. Разреши доступ к камере.");
  }

  if (!preview.srcObject) {
    preview.srcObject = new MediaStream([
      cameraTrack.mediaStreamTrack
    ]);
  }

  preview.hidden = false;
  await preview.play().catch(() => {});

  for (let i = 0; i < 80; i++) {
    if (preview.videoWidth > 0 && preview.videoHeight > 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!preview.videoWidth || !preview.videoHeight) {
    throw new Error("Камера не передаёт изображение. Попробуй ещё раз.");
  }

  maskCanvas = document.createElement("canvas");
  maskCanvas.width = preview.videoWidth;
  maskCanvas.height = preview.videoHeight;

  maskContext = maskCanvas.getContext("2d", {
    alpha: false,
    desynchronized: true
  });

  if (!maskContext) {
    throw new Error("Не удалось подготовить обработку видео.");
  }

  maskContext.fillStyle = "#000";
  maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

  if (typeof maskCanvas.captureStream !== "function") {
    throw new Error(
      "Этот браузер не поддерживает передачу видео с масками. Попробуй обновить браузер."
    );
  }

  canvasStream = maskCanvas.captureStream(24);
  const canvasTrack = canvasStream.getVideoTracks()[0];

  if (!canvasTrack || !sdk.LocalVideoTrack) {
    throw new Error("Не удалось подготовить видео для LiveKit.");
  }

  processedVideoTrack = new sdk.LocalVideoTrack(canvasTrack);

  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
  }
  renderFrameId = requestAnimationFrame(renderFrame);

  if (maskSelect?.value && maskSelect.value !== "none") {
    await loadFaceMesh();
  }

  return processedVideoTrack;
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
      await ensureProcessedVideoTrack();
    }

    status("Камера включена. Выбери маску или начинай эфир.");
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
      status("Войди в аккаунт, чтобы открыть студию.");
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

if (loginForm) {
  loginForm.addEventListener("submit", async event => {
    event.preventDefault();

    if (loginButton) loginButton.disabled = true;

    try {
      status("Открываем страницу входа...");
      if (passwordInput) passwordInput.value = "";
      location.href = "/login.html?next=%2Fhost.html";
    } finally {
      if (loginButton) loginButton.disabled = false;
    }
  });
}

/* Выбор маски */
if (maskSelect) {
  maskSelect.addEventListener("change", async () => {
    if (maskSelect.value === "none") {
      faceLandmarks = null;
      status("Маска отключена.");
      return;
    }

    try {
      status("Загружаем распознавание лица...");
      await loadFaceMesh();
      status("Маска включена. Поверни голову, чтобы проверить отслеживание.");
    } catch (error) {
      console.error("Mask loading:", error);
      maskSelect.value = "none";
      faceLandmarks = null;
      status(
        "Не удалось загрузить маски. Проверь интернет и попробуй ещё раз."
      );
    }
  });
}

async function switchCamera() {
  if (isSwitchingCamera) return;

  isSwitchingCamera = true;
  if (cameraButton) cameraButton.disabled = true;

  try {
    sdk = sdk || await loadSDK();

    let cameraTrack = getCameraTrack();

    if (!cameraTrack) {
      await prepareCamera();
      cameraTrack = getCameraTrack();

      if (!cameraTrack) {
        throw new Error("Камера ещё не готова. Попробуй ещё раз.");
      }
    }

    if (typeof cameraTrack.restartTrack !== "function") {
      throw new Error("Переключение камеры не поддерживается.");
    }

    const nextFacingMode =
      currentFacingMode === "user" ? "environment" : "user";

    await cameraTrack.restartTrack({ facingMode: nextFacingMode });
    currentFacingMode = nextFacingMode;

    if (preview) {
      preview.srcObject = new MediaStream([
        cameraTrack.mediaStreamTrack
      ]);
      preview.hidden = false;
      await preview.play().catch(() => {});
    }

    status(
      currentFacingMode === "environment"
        ? "Включена задняя камера."
        : "Включена передняя камера."
    );
  } catch (error) {
    console.error("Camera switch:", error);
    status(error.message || "Не удалось переключить камеру.");
  } finally {
    isSwitchingCamera = false;
    if (cameraButton) cameraButton.disabled = false;
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

async function cleanupEffectsPipeline() {
  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
    renderFrameId = null;
  }

  faceLandmarks = null;
  faceMeshBusy = false;

  if (processedVideoTrack) {
    try {
      processedVideoTrack.stop();
    } catch {}
    processedVideoTrack = null;
  }

  if (canvasStream) {
    canvasStream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
    canvasStream = null;
  }

  if (faceMeshInstance) {
    try { await faceMeshInstance.close(); } catch {}
    faceMeshInstance = null;
  }

  maskCanvas = null;
  maskContext = null;
  maskLoadPromise = null;
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

  await cleanupEffectsPipeline();

  localTracks.forEach(track => {
    try { track.stop(); } catch {}
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

      const cameraTrack = getCameraTrack();
      if (!cameraTrack) {
        throw new Error("Камера не готова. Разреши доступ к камере.");
      }

      if (preview && !preview.srcObject) {
        preview.srcObject = new MediaStream([
          cameraTrack.mediaStreamTrack
        ]);
      }

      const outputVideoTrack = await ensureProcessedVideoTrack();

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
        if (track.kind === "audio") {
          await newRoom.localParticipant.publishTrack(track);
        }
      }

      await newRoom.localParticipant.publishTrack(outputVideoTrack);

      if (preview) {
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
          try { await room.disconnect(); } catch {}
        }

        room = null;
        activeRoomName = "";

        await cleanupEffectsPipeline();

        localTracks.forEach(track => {
          try { track.stop(); } catch {}
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
      try { track.stop(); } catch {}
    });
    localTracks = [];

    await cleanupEffectsPipeline();

    if (preview) {
      preview.srcObject = null;
      preview.hidden = true;
    }

    setStudioVisible(false);
    status("Ты вышел из аккаунта.");
    location.href = "/login.html?next=%2Fhost.html";
  });
}

window.addEventListener("beforeunload", () => {
  stopHeartbeat();

  if (room) room.disconnect();

  localTracks.forEach(track => {
    try { track.stop(); } catch {}
  });

  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
  }

  if (canvasStream) {
    canvasStream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
  }

  if (processedVideoTrack) {
    try { processedVideoTrack.stop(); } catch {}
  }

  if (faceMeshInstance) {
    try { faceMeshInstance.close(); } catch {}
  }
});

checkLogin();
