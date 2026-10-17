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

/* Подарки в эфире */
let giftTimer = null;
let giftLayer = null;
let giftPollBusy = false;
let lastGiftPollAt = null;
const seenGiftEvents = new Set();

/* Beauty effects pipeline */
let maskCanvas = null;
let maskContext = null;
let canvasStream = null;
let processedVideoTrack = null;
let faceMeshInstance = null;
let faceLandmarks = null;
let renderFrameId = null;
let faceMeshBusy = false;
let lastFaceMeshTime = 0;
let maskLoadPromise = null;

/* Отдельное видео для исходной камеры */
let sourceVideo = null;

function getSourceVideo() {
  if (sourceVideo) return sourceVideo;

  sourceVideo = document.createElement("video");
  sourceVideo.autoplay = true;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.setAttribute("aria-hidden", "true");

  Object.assign(sourceVideo.style, {
    position: "fixed",
    left: "-10px",
    top: "-10px",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1"
  });

  document.body.appendChild(sourceVideo);
  return sourceVideo;
}

function status(message) {
  if (statusText) statusText.textContent = message;
}

function setStudioVisible(authenticated) {
  if (loginPanel) loginPanel.hidden = authenticated;
  if (studioPanel) studioPanel.hidden = !authenticated;
  document.body.classList.toggle("studio-active", authenticated);

  const studioTop = document.querySelector(".studio-top");
  if (studioTop) {
    studioTop.hidden = false;
  }
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

/* ================================
   ПОДАРКИ ПОВЕРХ ВИДЕО ВЕДУЩЕГО
   ================================ */

function getGiftVideoContainer() {
  if (preview?.parentElement) {
    return preview.parentElement;
  }

  return document.querySelector(".studio-stage");
}

function setupHostGiftLayer() {
  const container = getGiftVideoContainer();
  if (!container) return null;

  if (
    giftLayer &&
    giftLayer.isConnected &&
    giftLayer.parentElement === container
  ) {
    return giftLayer;
  }

  if (!document.getElementById("hostGiftAnimationStyles")) {
    const style = document.createElement("style");
    style.id = "hostGiftAnimationStyles";

    style.textContent = `
      .host-gift-animation-layer {
        position: absolute;
        inset: 0;
        z-index: 100;
        overflow: hidden;
        pointer-events: none;
        contain: layout paint;
      }

      .host-gift-pop {
        position: absolute;
        left: 50%;
        bottom: 19%;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: calc(100% - 24px);
        padding: 10px 16px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 18px;
        color: #fff;
        background: rgba(12,12,12,.82);
        box-shadow: 0 5px 25px rgba(0,0,0,.35);
        box-sizing: border-box;
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        transform: translate(-50%, 0) scale(.7);
        opacity: 0;
        animation: hostGiftFly 3.4s ease-out forwards;
      }

      .host-gift-emoji {
        flex: 0 0 auto;
        font-size: clamp(36px, 9vw, 62px);
        line-height: 1;
        filter: drop-shadow(0 2px 8px rgba(255,80,140,.4));
        animation: hostGiftPulse .65s ease-in-out infinite alternate;
      }

      .host-gift-text {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .host-gift-sender {
        overflow: hidden;
        color: #ffd76a;
        font-size: 13px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .host-gift-name {
        overflow-wrap: anywhere;
        font-size: 16px;
        font-weight: 800;
      }

      .host-gift-quantity {
        color: #f5f5f5;
        font-size: 12px;
        font-weight: 600;
      }

      @keyframes hostGiftFly {
        0% {
          opacity: 0;
          transform: translate(-50%, 35px) scale(.65);
        }
        12% {
          opacity: 1;
          transform: translate(-50%, 0) scale(1.08);
        }
        20% {
          transform: translate(-50%, 0) scale(1);
        }
        72% {
          opacity: 1;
          transform: translate(-50%, -25px) scale(1);
        }
        100% {
          opacity: 0;
          transform: translate(-50%, -85px) scale(.9);
        }
      }

      @keyframes hostGiftPulse {
        from { transform: scale(.92) rotate(-5deg); }
        to { transform: scale(1.08) rotate(5deg); }
      }

      @media (max-width: 480px) {
        .host-gift-pop {
          bottom: 22%;
          gap: 9px;
          padding: 9px 12px;
        }

        .host-gift-name {
          font-size: 14px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .host-gift-pop {
          animation-duration: 2s;
        }

        .host-gift-emoji {
          animation: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  const computedPosition = window.getComputedStyle(container).position;

  if (computedPosition === "static") {
    container.style.position = "relative";
  }

  giftLayer = document.createElement("div");
  giftLayer.className = "host-gift-animation-layer";
  giftLayer.setAttribute("aria-hidden", "true");

  container.appendChild(giftLayer);
  return giftLayer;
}

function showHostGift(event) {
  const layer = setupHostGiftLayer();
  if (!layer || !event) return;

  const gift = event.gift || {};
  const emoji = gift.emoji || event.emoji || "🎁";
  const giftName =
    gift.name || event.giftName || event.name || "Подарок";
  const senderName =
    event.senderName || event.sender_name || "Гость";
  const quantity = Math.max(1, Number(event.quantity) || 1);

  const pop = document.createElement("div");
  pop.className = "host-gift-pop";

  const emojiElement = document.createElement("div");
  emojiElement.className = "host-gift-emoji";
  emojiElement.textContent = emoji;

  const textElement = document.createElement("div");
  textElement.className = "host-gift-text";

  const senderElement = document.createElement("div");
  senderElement.className = "host-gift-sender";
  senderElement.textContent = senderName + " отправил(а) подарок";

  const nameElement = document.createElement("div");
  nameElement.className = "host-gift-name";
  nameElement.textContent = giftName;

  textElement.append(senderElement, nameElement);

  if (quantity > 1) {
    const quantityElement = document.createElement("div");
    quantityElement.className = "host-gift-quantity";
    quantityElement.textContent = "Количество: ×" + quantity;
    textElement.appendChild(quantityElement);
  }

  pop.append(emojiElement, textElement);
  layer.appendChild(pop);

  while (layer.children.length > 5) {
    layer.firstElementChild.remove();
  }

  window.setTimeout(() => pop.remove(), 3600);
}

async function loadHostGiftEvents() {
  if (!activeRoomName || isStopping || giftPollBusy) return;

  giftPollBusy = true;

  const pollStartedAt = new Date().toISOString();

  try {
    const query = new URLSearchParams({
      roomName: activeRoomName,
      since: lastGiftPollAt || new Date(Date.now() - 15000).toISOString()
    });

    const response = await apiFetch(
      "/api/gifts/events?" + query.toString()
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || `Ошибка загрузки подарков: ${response.status}`
      );
    }

    const events = Array.isArray(data)
      ? data
      : Array.isArray(data.events)
        ? data.events
        : [];

    events.forEach(event => {
      const eventKey = event.id != null
        ? String(event.id)
        : [
            event.created_at || "",
            event.sender_id || "",
            event.gift_id || event.gift?.id || "",
            event.quantity || 1
          ].join(":");

      if (seenGiftEvents.has(eventKey)) return;

      seenGiftEvents.add(eventKey);
      showHostGift(event);
    });

    if (seenGiftEvents.size > 500) {
      const recentKeys = Array.from(seenGiftEvents).slice(-250);
      seenGiftEvents.clear();
      recentKeys.forEach(key => seenGiftEvents.add(key));
    }

    lastGiftPollAt = pollStartedAt;
  } catch (error) {
    /* Ошибка подарков не должна останавливать эфир */
    console.warn("Не удалось загрузить подарки ведущего:", error.message);
  } finally {
    giftPollBusy = false;
  }
}

function startHostGiftEvents() {
  stopHostGiftEvents();

  lastGiftPollAt = new Date(Date.now() - 15000).toISOString();
  seenGiftEvents.clear();

  setupHostGiftLayer();
  loadHostGiftEvents();

  giftTimer = setInterval(loadHostGiftEvents, 2500);
}

function stopHostGiftEvents() {
  if (giftTimer) {
    clearInterval(giftTimer);
    giftTimer = null;
  }

  giftPollBusy = false;
  lastGiftPollAt = null;
  seenGiftEvents.clear();

  if (giftLayer) {
    giftLayer.replaceChildren();
  }
}


/* ===== ЧАТ ЗРИТЕЛЕЙ В СТУДИИ ВЕДУЩЕГО ===== */

let hostChatTimer = null;
let hostChatBusy = false;

function renderHostChat(messages) {
  const panel = $("hostChat");
  const list = $("hostChatMessages");
  const count = $("hostChatCount");

  if (!panel || !list || !count) return;

  const items = Array.isArray(messages) ? messages : [];

  count.textContent = String(items.length);
  list.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "host-chat-empty";
    empty.textContent = "Сообщений пока нет";
    list.appendChild(empty);
    return;
  }

  items.forEach(item => {
    const message = document.createElement("div");
    message.className = "host-chat-message";

    const name = document.createElement("div");
    name.className = "host-chat-name";
    name.textContent =
      item.participant_name || item.username || item.sender_name || "Гость";

    const text = document.createElement("div");
    text.textContent = item.message || "";

    message.append(name, text);
    list.appendChild(message);
  });

  list.scrollTop = list.scrollHeight;
}

async function loadHostChat() {
  if (!activeRoomName || isStopping || hostChatBusy) return;

  hostChatBusy = true;
  const roomName = activeRoomName;

  try {
    const response = await apiFetch(
      "/api/chat?roomName=" + encodeURIComponent(roomName)
    );

    if (!response.ok) {
      throw new Error("Ошибка загрузки чата: " + response.status);
    }

    const messages = await response.json();

    if (activeRoomName !== roomName || isStopping) return;

    renderHostChat(messages);
  } catch (error) {
    console.warn("Не удалось загрузить чат ведущего:", error.message);
  } finally {
    hostChatBusy = false;
  }
}

function startHostChat() {
  stopHostChat();

  const panel = $("hostChat");
  if (panel) panel.hidden = false;

  renderHostChat([]);
  loadHostChat();

  hostChatTimer = setInterval(loadHostChat, 2000);
}

function stopHostChat() {
  if (hostChatTimer) {
    clearInterval(hostChatTimer);
    hostChatTimer = null;
  }

  hostChatBusy = false;

  const panel = $("hostChat");
  if (panel) panel.hidden = true;
}


/* Загрузка MediaPipe для отслеживания лица */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(s => s.src === src);

    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
      } else {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => {
          reject(new Error("Не удалось загрузить библиотеку эффектов"));
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
      reject(new Error("Не удалось загрузить библиотеку эффектов"));
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

function faceWidth() {
  const left = point(234);
  const right = point(454);

  if (!left || !right) return 0;

  return Math.hypot(right.x - left.x, right.y - left.y);
}

/* Румянец */
function drawCheekBlush(ctx, width, opacity, color) {
  const left = point(205);
  const right = point(425);

  if (!left || !right || width < 10) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  for (const p of [left, right]) {
    const gradient = ctx.createRadialGradient(
      p.x, p.y, width * 0.01,
      p.x, p.y, width * 0.13
    );

    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "rgba(255,100,150,0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(
      p.x, p.y,
      width * 0.12, width * 0.065,
      0, 0, Math.PI * 2
    );
    ctx.fill();
  }

  ctx.restore();
}

/* Цвет губ */
function drawLipColor(ctx, width, color, opacity) {
  const upper = point(13);
  const lower = point(14);
  const left = point(61);
  const right = point(291);

  if (!upper || !lower || !left || !right || width < 10) return;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;

  ctx.beginPath();
  ctx.moveTo(left.x, left.y);

  ctx.quadraticCurveTo(
    upper.x - width * 0.035,
    upper.y - width * 0.025,
    upper.x,
    upper.y
  );

  ctx.quadraticCurveTo(
    upper.x + width * 0.035,
    upper.y - width * 0.025,
    right.x,
    right.y
  );

  ctx.quadraticCurveTo(
    lower.x + width * 0.025,
    lower.y + width * 0.02,
    lower.x,
    lower.y
  );

  ctx.quadraticCurveTo(
    lower.x - width * 0.025,
    lower.y + width * 0.02,
    left.x,
    left.y
  );

  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* Лёгкий макияж глаз */
function drawEyeMakeup(ctx, width, color, opacity) {
  const eyes = [
    [33, 133, 159],
    [362, 263, 386]
  ];

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, width * 0.012);
  ctx.lineCap = "round";

  for (const [outerId, innerId, upperId] of eyes) {
    const outer = point(outerId);
    const inner = point(innerId);
    const upper = point(upperId);

    if (!outer || !inner || !upper) continue;

    ctx.beginPath();
    ctx.moveTo(outer.x, outer.y);
    ctx.quadraticCurveTo(
      upper.x,
      upper.y - width * 0.012,
      inner.x,
      inner.y
    );
    ctx.stroke();
  }

  ctx.restore();
}

/* Beauty / Glamour / Макияж / Pink */
function drawBeautyFilter() {
  if (!maskContext || !maskCanvas) return;

  const selected = maskSelect?.value || "none";
  if (selected === "none") return;

  const settingsByFilter = {
    beauty: {
      tint: "rgba(255,220,230,0.045)",
      blush: 0.22,
      blushColor: "#ff7799",
      lips: "#e96b88",
      lipOpacity: 0.24,
      eyes: "#68404f",
      eyeOpacity: 0.15
    },
    glamour: {
      tint: "rgba(255,190,220,0.075)",
      blush: 0.38,
      blushColor: "#ff5688",
      lips: "#d92862",
      lipOpacity: 0.48,
      eyes: "#442235",
      eyeOpacity: 0.42
    },
    makeup: {
      tint: "rgba(255,215,225,0.035)",
      blush: 0.28,
      blushColor: "#f45b86",
      lips: "#d83255",
      lipOpacity: 0.58,
      eyes: "#301b2a",
      eyeOpacity: 0.48
    },
    pink: {
      tint: "rgba(255,105,180,0.085)",
      blush: 0.42,
      blushColor: "#ff69b4",
      lips: "#ff3985",
      lipOpacity: 0.48,
      eyes: "#82365f",
      eyeOpacity: 0.28
    }
  };

  const settings = settingsByFilter[selected];
  if (!settings) return;

  const ctx = maskContext;

  ctx.save();
  ctx.fillStyle = settings.tint;
  ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  ctx.restore();

  const width = faceWidth();
  if (width < 10 || !faceLandmarks) return;

  drawCheekBlush(ctx, width, settings.blush, settings.blushColor);
  drawLipColor(ctx, width, settings.lips, settings.lipOpacity);
  drawEyeMakeup(ctx, width, settings.eyes, settings.eyeOpacity);
}

/* Обрабатываем исходную камеру, а не preview */
function renderFrame() {
  if (!sourceVideo || !maskCanvas || !maskContext) return;

  if (
    sourceVideo.readyState >= 2 &&
    sourceVideo.videoWidth > 0 &&
    sourceVideo.videoHeight > 0
  ) {
    if (
      maskCanvas.width !== sourceVideo.videoWidth ||
      maskCanvas.height !== sourceVideo.videoHeight
    ) {
      maskCanvas.width = sourceVideo.videoWidth;
      maskCanvas.height = sourceVideo.videoHeight;
    }

    maskContext.drawImage(
      sourceVideo,
      0,
      0,
      maskCanvas.width,
      maskCanvas.height
    );

    drawBeautyFilter();

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

      faceMeshInstance.send({ image: sourceVideo })
        .catch(error => console.error("Face Mesh:", error))
        .finally(() => {
          faceMeshBusy = false;
        });
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

  const inputVideo = getSourceVideo();

  inputVideo.srcObject = new MediaStream([
    cameraTrack.mediaStreamTrack
  ]);

  await inputVideo.play().catch(() => {});

  for (let i = 0; i < 80; i++) {
    if (inputVideo.videoWidth > 0 && inputVideo.videoHeight > 0) {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!inputVideo.videoWidth || !inputVideo.videoHeight) {
    throw new Error("Камера не передаёт изображение. Попробуй ещё раз.");
  }

  maskCanvas = document.createElement("canvas");
  maskCanvas.width = inputVideo.videoWidth;
  maskCanvas.height = inputVideo.videoHeight;

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
      "Этот браузер не поддерживает передачу обработанного видео. Попробуй обновить браузер."
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

  if (preview) {
    preview.srcObject = canvasStream;
    preview.muted = true;
    preview.playsInline = true;
    preview.hidden = false;
    await preview.play().catch(() => {});
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
      await ensureProcessedVideoTrack();
    }

    status("Камера включена. Выбери Beauty-фильтр или начинай эфир.");
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

/* Выбор Beauty-фильтра */
if (maskSelect) {
  maskSelect.addEventListener("change", async () => {
    if (maskSelect.value === "none") {
      faceLandmarks = null;
      status("Эффект отключён.");
      return;
    }

    try {
      status("Загружаем распознавание лица...");
      await loadFaceMesh();
      status("Эффект включён. Поверни голову, чтобы проверить отслеживание.");
    } catch (error) {
      console.error("Beauty filter loading:", error);
      maskSelect.value = "none";
      faceLandmarks = null;
      status(
        "Не удалось загрузить эффекты. Проверь интернет и попробуй ещё раз."
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

    const inputVideo = getSourceVideo();

    inputVideo.srcObject = new MediaStream([
      cameraTrack.mediaStreamTrack
    ]);

    await inputVideo.play().catch(() => {});

    if (!processedVideoTrack && preview) {
      preview.srcObject = inputVideo.srcObject;
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
      try {
        track.stop();
      } catch {}
    });
    canvasStream = null;
  }

  if (faceMeshInstance) {
    try {
      await faceMeshInstance.close();
    } catch {}
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
  stopHostGiftEvents();

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
    try {
      track.stop();
    } catch {}
  });
  localTracks = [];

  const inputVideo = getSourceVideo();
  inputVideo.srcObject = null;

  if (preview) {
    preview.srcObject = null;
    preview.hidden = true;
  }

  if (stopButton) stopButton.hidden = true;

  /* ПОКАЗЫВАЕМ НАЗВАНИЕ И СТРАНУ ПОСЛЕ ОСТАНОВКИ ЭФИРА */
  const studioTop = document.querySelector(".studio-top");
  if (studioTop) studioTop.hidden = false;

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

      const inputVideo = getSourceVideo();

      if (!inputVideo.srcObject) {
        inputVideo.srcObject = new MediaStream([
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

      /* Зрителям публикуется видео с эффектами */
      await newRoom.localParticipant.publishTrack(outputVideoTrack);

      if (preview) {
        preview.srcObject = canvasStream;
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

      /* СКРЫВАЕМ НАЗВАНИЕ И СТРАНУ ПОСЛЕ УСПЕШНОГО ЗАПУСКА */
      const studioTop = document.querySelector(".studio-top");
      if (studioTop) studioTop.hidden = true;

      startHeartbeat();

      /* Запускаем показ подарков только после подключения эфира */
      startHostGiftEvents();

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
        stopHostGiftEvents();

        if (room) {
          try {
            await room.disconnect();
          } catch {}
        }

        room = null;
        activeRoomName = "";

        await cleanupEffectsPipeline();

        localTracks.forEach(track => {
          try {
            track.stop();
          } catch {}
        });
        localTracks = [];

        const inputVideo = getSourceVideo();
        inputVideo.srcObject = null;

        if (preview) {
          preview.srcObject = null;
          preview.hidden = true;
        }

        if (stopButton) stopButton.hidden = true;

        /* При ошибке поля остаются видимыми */
        const studioTop = document.querySelector(".studio-top");
        if (studioTop) studioTop.hidden = false;

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

    await cleanupEffectsPipeline();

    const inputVideo = getSourceVideo();
    inputVideo.srcObject = null;

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
  stopHostGiftEvents();

  if (room) room.disconnect();

  localTracks.forEach(track => {
    try {
      track.stop();
    } catch {}
  });

  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
  }

  if (canvasStream) {
    canvasStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch {}
    });
  }

  if (processedVideoTrack) {
    try {
      processedVideoTrack.stop();
    } catch {}
  }

  if (faceMeshInstance) {
    try {
      faceMeshInstance.close();
    } catch {}
  }

  if (sourceVideo) {
    sourceVideo.srcObject = null;
  }
});

checkLogin();






/* ===== ШКАЛА ЗАРАБОТКА ВЕДУЩЕГО ===== */
(() => {
  let earningsTimer = null;
  let earningsBusy = false;

  function createEarningsPanel() {
    let panel = document.getElementById("hostEarningsPanel");
    if (panel) return panel;

    if (!document.getElementById("hostEarningsStyles")) {
      const style = document.createElement("style");
      style.id = "hostEarningsStyles";
      style.textContent = `
        #hostEarningsPanel {
          position: fixed;
          z-index: 150;
          top: calc(12px + env(safe-area-inset-top, 0px));
          left: 10px;
          width: 190px;
          box-sizing: border-box;
          padding: 12px;
          border: 1px solid rgba(255,255,255,.18);
          border-radius: 14px;
          color: #fff;
          background: rgba(12,12,12,.90);
          font: 13px/1.4 Arial,sans-serif;
          box-shadow: 0 4px 18px rgba(0,0,0,.3);
          display: none;
          pointer-events: none;
        }
        #hostEarningsPanel .he-title {
          font-weight: 800;
          margin-bottom: 7px;
        }
        #hostEarningsPanel .he-amount {
          color: #66efa0;
          font-size: 23px;
          font-weight: 800;
          margin-bottom: 7px;
        }
        #hostEarningsPanel .he-track {
          height: 8px;
          border-radius: 99px;
          overflow: hidden;
          background: rgba(255,255,255,.2);
          margin: 7px 0;
        }
        #hostEarningsPanel .he-fill {
          height: 100%;
          width: 0%;
          border-radius: inherit;
          background: linear-gradient(90deg,#25c878,#b6ff6b);
          transition: width .35s ease;
        }
        #hostEarningsPanel .he-detail {
          color: #ddd;
          font-size: 11px;
        }
        @media(max-width:480px) {
          #hostEarningsPanel {
            top: calc(10px + env(safe-area-inset-top, 0px));
            left: 8px;
            width: 155px;
            padding: 9px;
          }
          #hostEarningsPanel .he-amount { font-size: 20px; }
        }
      `;
      document.head.appendChild(style);
    }

    panel = document.createElement("div");
    panel.id = "hostEarningsPanel";
    panel.innerHTML = `
      <div class="he-title">💰 Мой заработок</div>
      <div class="he-amount" id="heAmount">$0.00</div>
      <div class="he-track"><div class="he-fill" id="heFill"></div></div>
      <div id="heProgress">0% от цели $100</div>
      <div class="he-detail" id="heCoins">Получено монет: 0</div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  async function updateEarnings() {
    if (earningsBusy) return;
    earningsBusy = true;

    try {
      const response = await apiFetch("/api/host/earnings");
      const data = await response.json();

      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Не удалось загрузить заработок");
      }

      const amount = Number(data.hostEarningsUsd) || 0;
      const goal = Number(data.goalUsd) || 100;
      const coins = Number(data.totalCoins) || 0;
      const progress = Math.max(
        0,
        Math.min(100, Number(data.progressPercent) || (amount / goal * 100))
      );

      createEarningsPanel().style.display =
        activeRoomName && !isStopping ? "block" : "none";

      document.getElementById("heAmount").textContent =
        "$" + amount.toFixed(2);
      document.getElementById("heFill").style.width = progress + "%";
      document.getElementById("heProgress").textContent =
        progress.toFixed(1) + "% от цели $" + goal.toFixed(0);
      document.getElementById("heCoins").textContent =
        "Получено монет: " + coins.toLocaleString("ru-RU");
    } catch (error) {
      console.warn("Загрузка заработка:", error.message);
    } finally {
      earningsBusy = false;
    }
  }

  function startEarningsUpdates() {
    if (earningsTimer) clearInterval(earningsTimer);
    updateEarnings();
    earningsTimer = setInterval(updateEarnings, 5000);
  }

  function stopEarningsUpdates() {
    if (earningsTimer) {
      clearInterval(earningsTimer);
      earningsTimer = null;
    }
    const panel = document.getElementById("hostEarningsPanel");
    if (panel) panel.style.display = "none";
  }

const originalStartHostGiftEvents = startHostGiftEvents;

startHostGiftEvents = function () {
  originalStartHostGiftEvents();
  startEarningsUpdates();
  startHostChat();
};

const originalStopHostGiftEvents = stopHostGiftEvents;

stopHostGiftEvents = function () {
  originalStopHostGiftEvents();
  stopEarningsUpdates();
  stopHostChat();
};

  window.addEventListener("beforeunload", stopEarningsUpdates);
})();
