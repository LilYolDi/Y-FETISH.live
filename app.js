"use strict";

const videoContainer = document.getElementById("videoContainer");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const streamTitle = document.getElementById("streamTitle");
const hostName = document.getElementById("hostName");
const giftList = document.getElementById("giftList");
const giftMessage = document.getElementById("giftMessage");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

let room = null;
let connected = false;

const params = new URLSearchParams(window.location.search);

function showMessage(element, message) {
  if (element) element.textContent = message;
}

function getRoomName() {
  return (
    params.get("room") ||
    params.get("roomName") ||
    ""
  ).trim();
}

function getParticipantName() {
  let name = params.get("name") || "Гость";
  return name.trim().slice(0, 50) || "Гость";
}

async function loadLiveKitSDK() {
  if (window.LivekitClient) {
    return window.LivekitClient;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://unpkg.com/livekit-client/dist/livekit-client.umd.min.js";
    script.async = true;

    script.onload = resolve;
    script.onerror = () =>
      reject(new Error("Не удалось загрузить видеоплеер LiveKit"));

    document.head.appendChild(script);
  });

  if (!window.LivekitClient) {
    throw new Error("Библиотека LiveKit недоступна");
  }

  return window.LivekitClient;
}

function showVideoTrack(track) {
  if (!track || !videoContainer) return;

  if (videoPlaceholder) {
    videoPlaceholder.style.display = "none";
  }

  const element = track.attach();

  element.style.width = "100%";
  element.style.height = "100%";
  element.style.objectFit = "contain";

  if (track.kind === "video") {
    element.autoplay = true;
    element.playsInline = true;
    element.muted = true;
  }

  videoContainer.appendChild(element);

  if (element.tagName === "VIDEO") {
    element.play().catch(() => {});
  }
}

function removeVideoTrack(track) {
  if (!track) return;

  track.detach().forEach((element) => element.remove());

  const hasVideo = videoContainer?.querySelector("video");

  if (!hasVideo && videoPlaceholder) {
    videoPlaceholder.style.display = "";
  }
}

async function connectToStream() {
  const roomName = getRoomName();

  if (!roomName) {
    showMessage(streamTitle, "Прямой эфир");
    showMessage(
      videoPlaceholder?.querySelector("p"),
      "Не указан эфир. Открой ссылку с параметром ?room=ИМЯ_КОМНАТЫ"
    );
    return;
  }

  try {
    showMessage(
      videoPlaceholder?.querySelector("p"),
      "Подключение к эфиру..."
    );

    const client = await loadLiveKitSDK();

    const response = await fetch("/api/livekit/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        roomName,
        participantName: getParticipantName(),
        isHost: false
      })
    });

    const credentials = await response.json();

    if (!response.ok) {
      throw new Error(
        credentials.error || "Не удалось получить доступ к эфиру"
      );
    }

    if (!credentials.serverUrl || !credentials.token) {
      throw new Error("Сервер не вернул данные для подключения");
    }

    room = new client.Room({
      adaptiveStream: true,
      dynacast: true
    });

    room.on(client.RoomEvent.TrackSubscribed, (track) => {
      showVideoTrack(track);
    });

    room.on(client.RoomEvent.TrackUnsubscribed, (track) => {
      removeVideoTrack(track);
    });

    room.on(client.RoomEvent.Disconnected, () => {
      connected = false;

      showMessage(
        videoPlaceholder?.querySelector("p"),
        "Соединение с эфиром потеряно"
      );

      if (videoPlaceholder) {
        videoPlaceholder.style.display = "";
      }
    });

    await room.connect(credentials.serverUrl, credentials.token);

    connected = true;

    showMessage(
      videoPlaceholder?.querySelector("p"),
      "Вы подключены. Ожидание видео ведущего..."
    );

    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.track) {
          showVideoTrack(publication.track);
        }
      });
    });

  } catch (error) {
    console.error("LiveKit error:", error);

    showMessage(
      videoPlaceholder?.querySelector("p"),
      error.message || "Не удалось подключиться к эфиру"
    );
  }
}

async function loadGifts() {
  if (!giftList) return;

  try {
    const response = await fetch("/api/gifts");

    if (!response.ok) {
      throw new Error("Ошибка загрузки подарков");
    }

    const gifts = await response.json();

    giftList.replaceChildren();

    if (!Array.isArray(gifts) || gifts.length === 0) {
      showMessage(giftList, "Подарков пока нет");
      return;
    }

    gifts.forEach((gift) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "gift-item";
      button.textContent =
        `${gift.emoji || "🎁"} ${gift.name} — ${gift.price} монет`;

      button.addEventListener("click", () => {
        showMessage(
          giftMessage,
          "Отправка подарков и оплата ещё не подключены."
        );
      });

      giftList.appendChild(button);
    });

  } catch (error) {
    console.error("Gifts error:", error);
    showMessage(giftList, "Не удалось загрузить подарки");
  }
}

if (chatForm) {
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!chatInput || !chatInput.value.trim()) return;

    showMessage(
      chatMessages,
      "Чат пока не подключён к серверу. Сообщение не отправлено."
    );

    chatInput.value = "";
  });
}

window.addEventListener("beforeunload", () => {
  if (room) {
    room.disconnect();
  }
});

connectToStream();
loadGifts();
