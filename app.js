"use strict";

const $ = (id) => document.getElementById(id);

const videoContainer = $("videoContainer");
const videoPlaceholder = $("videoPlaceholder");
const streamTitle = $("streamTitle");
const hostName = $("hostName");
const giftList = $("giftList");
const giftMessage = $("giftMessage");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");

const params = new URLSearchParams(window.location.search);
const roomName = (
  params.get("room") ||
  params.get("roomName") ||
  ""
).trim();
const participantName = (
  params.get("name") || "Гость"
).trim().slice(0, 50) || "Гость";

let liveRoom = null;
let lastChatError = "";

function showVideoMessage(message) {
  const p = videoPlaceholder?.querySelector("p");
  if (p) p.textContent = message;
}

async function loadLiveKitSDK() {
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

function attachVideo(track) {
  if (!videoContainer || !track) return;

  if (videoPlaceholder) videoPlaceholder.style.display = "none";

  const element = track.attach();
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.objectFit = "contain";

  if (element.tagName === "VIDEO") {
    element.autoplay = true;
    element.playsInline = true;
    element.muted = true;
  }

  videoContainer.appendChild(element);

  if (element.tagName === "VIDEO") {
    element.play().catch(() => {});
  }
}

function detachVideo(track) {
  if (!track) return;

  track.detach().forEach((element) => element.remove());

  if (
    videoPlaceholder &&
    !videoContainer.querySelector("video")
  ) {
    videoPlaceholder.style.display = "";
  }
}

async function connectToStream() {
  if (!roomName) {
    showVideoMessage("Для просмотра укажи комнату эфира в ссылке.");
    return;
  }

  try {
    showVideoMessage("Подключение к эфиру...");

    const client = await loadLiveKitSDK();

    const response = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName,
        participantName,
        isHost: false
      })
    });

    const credentials = await response.json();

    if (!response.ok) {
      throw new Error(credentials.error || "Ошибка подключения");
    }

    liveRoom = new client.Room({
      adaptiveStream: true,
      dynacast: true
    });

    liveRoom.on(client.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === "video" || track.kind === "audio") {
        attachVideo(track);
      }
    });

    liveRoom.on(client.RoomEvent.TrackUnsubscribed, detachVideo);

    liveRoom.on(client.RoomEvent.Disconnected, () => {
      showVideoMessage("Соединение с эфиром потеряно.");
      if (videoPlaceholder) videoPlaceholder.style.display = "";
    });

    await liveRoom.connect(credentials.serverUrl, credentials.token);

    liveRoom.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.track) attachVideo(publication.track);
      });
    });

    showVideoMessage("Подключено. Ожидание видео ведущего...");
  } catch (error) {
    console.error("LiveKit:", error);
    showVideoMessage(error.message || "Не удалось подключиться к эфиру.");
  }
}

async function loadGifts() {
  if (!giftList) return;

  try {
    const response = await fetch("/api/gifts");
    if (!response.ok) throw new Error("Ошибка загрузки");

    const gifts = await response.json();
    giftList.replaceChildren();

    if (!gifts.length) {
      giftList.textContent = "Подарков пока нет.";
      return;
    }

    gifts.forEach((gift) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gift-item";
      button.textContent =
        `${gift.emoji || "🎁"} ${gift.name} — ${gift.price} монет`;

      button.addEventListener("click", () => {
        if (giftMessage) {
          giftMessage.textContent =
            "Отправка и оплата подарков ещё не подключены.";
        }
      });

      giftList.appendChild(button);
    });
  } catch (error) {
    console.error("Gifts:", error);
    giftList.textContent = "Не удалось загрузить подарки.";
  }
}

function renderChat(messages) {
  if (!chatMessages) return;

  const wasAtBottom =
    chatMessages.scrollHeight -
    chatMessages.scrollTop -
    chatMessages.clientHeight < 50;

  chatMessages.replaceChildren();

  if (!messages.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Пока нет сообщений. Напиши первым!";
    chatMessages.appendChild(p);
    return;
  }

  messages.forEach((item) => {
    const row = document.createElement("p");
    const name = document.createElement("strong");
    const text = document.createElement("span");

    name.textContent = `${item.participant_name}: `;
    text.textContent = item.message;

    row.append(name, text);
    chatMessages.appendChild(row);
  });

  if (wasAtBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

async function loadChat() {
  if (!chatMessages || !roomName) {
    if (chatMessages) {
      chatMessages.textContent =
        "Открой ссылку эфира с параметром ?room=название-комнаты";
    }
    return;
  }

  try {
    const response = await fetch(
      `/api/chat?room=${encodeURIComponent(roomName)}`
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось загрузить чат");
    }

    lastChatError = "";
    renderChat(Array.isArray(result) ? result : []);
  } catch (error) {
    console.error("Chat load:", error);
    if (lastChatError !== error.message) {
      chatMessages.textContent = error.message;
      lastChatError = error.message;
    }
  }
}

if (chatForm && chatInput) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const message = chatInput.value.trim();
    if (!message || !roomName) return;

    const button = chatForm.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName,
          participantName,
          message
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Не удалось отправить сообщение");
      }

      chatInput.value = "";
      await loadChat();
    } catch (error) {
      console.error("Chat send:", error);
      if (giftMessage) giftMessage.textContent = error.message;
      else alert(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

window.addEventListener("beforeunload", () => {
  if (liveRoom) liveRoom.disconnect();
});

connectToStream();
loadGifts();
loadChat();
setInterval(loadChat, 2500);
