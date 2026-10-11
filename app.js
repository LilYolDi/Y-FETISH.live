"use strict";

const $ = (id) => document.getElementById(id);

const videoContainer = $("videoContainer") || $("videoPlayer") || $("liveVideo");
const statusElement = $("status");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const giftsContainer = $("gifts");
const giftList = $("giftList");

let room = null;
let chatTimer = null;
let isConnecting = false;

const params = new URLSearchParams(window.location.search);
const roomName = params.get("room") || params.get("roomName");

function setStatus(message) {
  if (statusElement) statusElement.textContent = message;
}

function getVideoContainer() {
  if (videoContainer) return videoContainer;

  let container = $("videoContainer") || $("videoPlayer") || $("liveVideo");

  if (!container) {
    container = document.createElement("div");
    container.id = "videoContainer";
    container.style.cssText =
      "width:100%;min-height:240px;background:#111;display:flex;" +
      "flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;";
    document.body.appendChild(container);
  }

  return container;
}

function loadSDK() {
  if (window.LivekitClient) {
    return Promise.resolve(window.LivekitClient);
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";

    script.onload = () => {
      if (window.LivekitClient) {
        resolve(window.LivekitClient);
      } else {
        reject(new Error("Библиотека LiveKit не загрузилась."));
      }
    };

    script.onerror = () =>
      reject(new Error("Не удалось загрузить LiveKit."));

    document.head.appendChild(script);
  });
}

/* Видео на всю площадь контейнера */
function attachTrack(track, participant) {
  const container = getVideoContainer();
  const element = track.attach();

  element.autoplay = true;
  element.playsInline = true;

  if (track.kind === "video") {
    element.muted = true;
    element.setAttribute("playsinline", "");
    element.setAttribute("webkit-playsinline", "");

    element.style.cssText =
      "position:absolute;inset:0;display:block;" +
      "width:100%;height:100%;max-width:none;max-height:none;" +
      "object-fit:cover;object-position:center;" +
      "background:#000;border:0;border-radius:0;";

    container.style.position = "fixed";
    container.style.inset = "0";
    container.style.width = "100vw";
    container.style.height = "100vh";
    container.style.setProperty("height", "100dvh");
    container.style.maxWidth = "none";
    container.style.maxHeight = "none";
    container.style.margin = "0";
    container.style.padding = "0";
    container.style.overflow = "hidden";
    container.style.border = "0";
    container.style.borderRadius = "0";
    container.style.background = "#000";
  } else if (track.kind === "audio") {
    element.autoplay = true;
    element.muted = false;
  }

  element.dataset.participant =
    participant.identity || "participant";

  container.appendChild(element);

  element.play?.().catch(() => {
    setStatus("Нажми на страницу, чтобы разрешить воспроизведение.");
  });
}

function detachTrack(track) {
  track.detach().forEach((element) => element.remove());
}

async function connectToStream() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (!roomName) {
      throw new Error("Не указана комната эфира в ссылке.");
    }

    setStatus("Подключаемся к эфиру...");

    const sdk = await loadSDK();

    const response = await fetch("/api/livekit/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName,
        participantName: "Guest",
        isHost: false
      }),
      cache: "no-store"
    });

    const credentials = await response.json();

    if (!response.ok) {
      throw new Error(
        credentials.error || "Не удалось получить доступ к эфиру."
      );
    }

    if (!credentials.serverUrl || !credentials.token) {
      throw new Error("Сервер не вернул данные для подключения LiveKit.");
    }

    room = new sdk.Room({
      adaptiveStream: true,
      dynacast: true
    });

    room.on(
      sdk.RoomEvent.TrackSubscribed,
      (track, publication, participant) => {
        attachTrack(track, participant);
        setStatus("Ты подключён к эфиру.");
      }
    );

    room.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
      detachTrack(track);
    });

    room.on(sdk.RoomEvent.ParticipantDisconnected, () => {
      setStatus("Участник отключился.");
    });

    room.on(sdk.RoomEvent.Disconnected, () => {
      setStatus("Соединение с эфиром завершено.");
    });

    await room.connect(credentials.serverUrl, credentials.token);

    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.track && publication.isSubscribed) {
          attachTrack(publication.track, participant);
        }
      });
    });

    setStatus("Подключено. Ожидаем видео ведущего...");

    loadGifts();
    await loadChat();

    if (chatTimer) clearInterval(chatTimer);
    chatTimer = setInterval(loadChat, 3000);

  } catch (error) {
    console.error("Ошибка подключения к эфиру:", error);
    setStatus(error.message || "Не удалось подключиться к эфиру.");
  } finally {
    isConnecting = false;
  }
}

async function loadChat() {
  if (!chatMessages) return;

  try {
    const response = await fetch(
      `/api/chat?roomName=${encodeURIComponent(roomName || "")}`,
      { credentials: "same-origin", cache: "no-store" }
    );

    if (!response.ok) return;

    const result = await response.json();
    const messages = Array.isArray(result) ? result : result.messages;

    if (!Array.isArray(messages)) return;

    chatMessages.replaceChildren();

    messages.forEach((message) => {
      const item = document.createElement("div");
      item.className = "chat-message";

      const author = document.createElement("strong");
      author.textContent =
        message.username || message.name || message.sender || "Гость";

      const text = document.createElement("span");
      text.textContent = ` ${message.message || message.text || ""}`;

      item.append(author, text);
      chatMessages.appendChild(item);
    });

    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (error) {
    console.error("Ошибка загрузки чата:", error);
  }
}

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const message = chatInput?.value.trim();
    if (!message) return;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName,
          message
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || "Не удалось отправить сообщение."
        );
      }

      chatInput.value = "";
      await loadChat();
    } catch (error) {
      console.error("Ошибка отправки сообщения:", error);
      setStatus(error.message || "Не удалось отправить сообщение.");
    }
  });
}

async function loadGifts() {
  const container = giftsContainer || giftList;
  if (!container) return;

  try {
    const response = await fetch("/api/gifts", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) return;

    const result = await response.json();
    const gifts = Array.isArray(result) ? result : result.gifts;

    if (!Array.isArray(gifts)) return;

    container.replaceChildren();

    gifts.forEach((gift) => {
      const item = document.createElement("div");
      item.className = "gift-item";
      item.textContent =
        `${gift.emoji || "🎁"} ${gift.name || gift.title || "Подарок"}` +
        (gift.price != null ? ` — ${gift.price}` : "");

      container.appendChild(item);
    });
  } catch (error) {
    console.error("Ошибка загрузки подарков:", error);
  }
}

window.addEventListener("beforeunload", () => {
  if (chatTimer) clearInterval(chatTimer);
  if (room) room.disconnect();
});

connectToStream();
