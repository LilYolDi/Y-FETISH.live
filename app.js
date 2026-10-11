
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomName = params.get("room") || params.get("roomName") || "";

const statusElement = $("status");
const titleElement = $("streamTitle");
const hostElement = $("hostName");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const giftList = $("giftList") || $("gifts");
const coinBalance = $("coinBalance");
const giftMessage = $("giftMessage");

let liveRoom = null;
let chatTimer = null;
let connecting = false;

function setStatus(message) {
  if (statusElement) statusElement.textContent = message;
}

async function readJSON(response) {
  try { return await response.json(); }
  catch { return {}; }
}

function loadSDK() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";
    script.onload = () => window.LivekitClient
      ? resolve(window.LivekitClient)
      : reject(new Error("LiveKit не загрузился"));
    script.onerror = () => reject(new Error("Ошибка загрузки LiveKit"));
    document.head.appendChild(script);
  });
}

async function loadStreamInfo() {
  try {
    const response = await fetch("/api/streams", { cache: "no-store" });
    const streams = await readJSON(response);
    if (!response.ok || !Array.isArray(streams)) return;

    const stream = streams.find(item => item.room_name === roomName);
    if (!stream) return;

    if (titleElement) titleElement.textContent = stream.title;
    if (hostElement) hostElement.textContent = "Y-FETISH LIVE";
    document.title = `${stream.title} — Y-FETISH LIVE`;
  } catch (error) {
    console.error(error);
  }
}

function attachTrack(track, participant) {
  const container = $("videoContainer") || $("videoPlayer") || $("liveVideo");
  if (!container) return;

  const element = track.attach();
  element.autoplay = true;
  element.playsInline = true;

  if (track.kind === "video") {
    element.muted = true;
    element.setAttribute("playsinline", "");
    element.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;";
    container.style.position = "relative";
    container.style.overflow = "hidden";

    const placeholder = $("videoPlaceholder");
    if (placeholder) placeholder.style.display = "none";
  } else {
    element.muted = false;
    element.style.display = "none";
  }

  element.dataset.participant = participant.identity || "guest";
  container.appendChild(element);
  element.play?.().catch(() =>
    setStatus("Нажми на экран, чтобы разрешить воспроизведение.")
  );
}

async function connectLive() {
  if (connecting) return;
  connecting = true;

  try {
    if (!roomName) throw new Error("В ссылке не указана комната эфира");

    setStatus("Подключаемся к эфиру...");
    const sdk = await loadSDK();

    const response = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName,
        participantName: "Гость",
        isHost: false
      })
    });

    const credentials = await readJSON(response);
    if (!response.ok) throw new Error(credentials.error || "Ошибка доступа");

    liveRoom = new sdk.Room({ adaptiveStream: true, dynacast: true });

    liveRoom.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachTrack(track, participant);
      setStatus("Ты подключён к эфиру.");
    });

    liveRoom.on(sdk.RoomEvent.TrackUnsubscribed, track => {
      track.detach().forEach(element => element.remove());
    });

    liveRoom.on(sdk.RoomEvent.Disconnected, () => {
      setStatus("Соединение с эфиром завершено.");
    });

    await liveRoom.connect(credentials.serverUrl, credentials.token);

    liveRoom.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
        if (publication.track && publication.isSubscribed) {
          attachTrack(publication.track, participant);
        }
      });
    });

    setStatus("Подключено. Ожидаем видео ведущего...");
    await loadChat();
    await loadGifts();
    await loadWallet();

    if (chatTimer) clearInterval(chatTimer);
    chatTimer = setInterval(loadChat, 3000);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Не удалось подключиться");
  } finally {
    connecting = false;
  }
}

async function loadChat() {
  if (!chatMessages || !roomName) return;

  try {
    const response = await fetch(
      `/api/chat?roomName=${encodeURIComponent(roomName)}`,
      { cache: "no-store" }
    );
    const messages = await readJSON(response);
    if (!response.ok || !Array.isArray(messages)) return;

    const fragment = document.createDocumentFragment();

    messages.forEach(message => {
      const item = document.createElement("div");
      item.className = "chat-message";

      const author = document.createElement("strong");
      author.textContent = message.participant_name || "Гость";

      const text = document.createElement("span");
      text.textContent = ` ${message.message || ""}`;

      item.append(author, text);
      fragment.appendChild(item);
    });

    chatMessages.replaceChildren(fragment);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (error) {
    console.error(error);
  }
}

if (chatForm) {
  chatForm.addEventListener("submit", async event => {
    event.preventDefault();

    const message = chatInput?.value.trim();
    if (!message || !roomName) return;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName,
          participantName: "Гость",
          message
        })
      });

      const result = await readJSON(response);
      if (!response.ok) throw new Error(result.error || "Ошибка чата");

      chatInput.value = "";
      await loadChat();
    } catch (error) {
      setStatus(error.message);
    }
  });
}

async function loadGifts() {
  if (!giftList) return;

  try {
    const response = await fetch("/api/gifts", { cache: "no-store" });
    const gifts = await readJSON(response);
    if (!response.ok || !Array.isArray(gifts)) return;

    giftList.replaceChildren();

    gifts.forEach(gift => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gift-item";
      button.textContent =
        `${gift.emoji || "🎁"} ${gift.name || "Подарок"} — ${gift.price ?? 0} монет`;

      button.addEventListener("click", () => sendGift(gift.id));
      giftList.appendChild(button);
    });
  } catch (error) {
    console.error(error);
  }
}

async function loadWallet() {
  try {
    const response = await fetch("/api/wallet", {
      credentials: "same-origin",
      cache: "no-store"
    });

    const data = await readJSON(response);
    if (!response.ok) throw new Error(data.error || "Ошибка кошелька");

    if (coinBalance) coinBalance.textContent = data.balance;
  } catch (error) {
    if (giftMessage) giftMessage.textContent = error.message;
  }
}

async function sendGift(giftId) {
  if (!roomName) return;

  try {
    const response = await fetch("/api/gifts/send", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, giftId })
    });

    const data = await readJSON(response);
    if (!response.ok) throw new Error(data.error || "Не удалось отправить подарок");

    if (coinBalance) coinBalance.textContent = data.balance;
    if (giftMessage) {
      giftMessage.textContent = `${data.emoji || "🎁"} Подарок отправлен: ${data.gift}`;
    }
  } catch (error) {
    if (giftMessage) giftMessage.textContent = error.message;
  }
}

window.addEventListener("beforeunload", () => {
  if (chatTimer) clearInterval(chatTimer);
  if (liveRoom) liveRoom.disconnect();
});

loadStreamInfo();
connectLive();
