
(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const roomName = params.get("room");

  const $ = (selector) => document.querySelector(selector);

  const titleElement = $("#streamTitle");
  const hostNameElement = $("#hostName");
  const coinBalance = $("#coinBalance");
  const giftList = $("#giftList") || $("#gifts");
  const giftMessage = $("#giftMessage");
  const chatForm = $("#chatForm");
  const chatInput = $("#chatInput") || $('input[name="message"]');
  const chatList =
    $("#chatMessages") || $("#messages") || $("#chat");

  let liveRoom = null;
  let chatTimer = null;
  let lastMessageId = null;
  let firstChatLoad = true;

  function showMessage(message) {
    if (giftMessage) {
      giftMessage.textContent = message;
    } else {
      console.log(message);
    }
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
      throw new Error(
        data.error || `Ошибка сервера: ${response.status}`
      );
    }

    return data;
  }

  async function loadLiveKit() {
    if (window.LivekitClient || window.LiveKit) {
      return window.LivekitClient || window.LiveKit;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");

      script.src =
        "https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js";

      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("Не удалось загрузить LiveKit"));

      document.head.appendChild(script);
    });

    const sdk = window.LivekitClient || window.LiveKit;

    if (!sdk || !sdk.Room) {
      throw new Error("Библиотека LiveKit недоступна");
    }

    return sdk;
  }

  async function loadStreamInfo() {
    const data = await api("/api/streams");
    const streams = Array.isArray(data)
      ? data
      : data.streams || [];

    const stream = streams.find(
      (item) =>
        item.room_name === roomName &&
        item.status === "live"
    );

    if (!stream) {
      if (titleElement) {
        titleElement.textContent = "Эфир не найден или завершён";
      }

      return false;
    }

    if (titleElement) {
      titleElement.textContent = stream.title || "Прямой эфир";
    }

    if (hostNameElement) {
      hostNameElement.textContent =
        stream.host_name || "Ведущий";
    }

    return true;
  }

  function attachTrack(track) {
    const videoContainer =
      $("#videoContainer") ||
      $("#liveVideo") ||
      $("#videoPlayer") ||
      $(".video-container") ||
      $("video")?.parentElement;

    if (!videoContainer || !track) return;

    const element = track.attach();

    element.autoplay = true;
    element.playsInline = true;

    if (track.kind === "video") {
      element.style.width = "100%";
      element.style.height = "100%";
      element.style.objectFit = "contain";
    }

    if (track.kind === "audio") {
      element.autoplay = true;
    }

    videoContainer.appendChild(element);
  }

  async function connectLive() {
    if (!roomName) {
      if (titleElement) {
        titleElement.textContent = "В ссылке отсутствует номер эфира";
      }
      return;
    }

    const isActive = await loadStreamInfo();

    if (!isActive) return;

    const sdk = await loadLiveKit();

    const tokenData = await api(
      "/api/livekit/token?roomName=" +
      encodeURIComponent(roomName)
    );

    const liveKitUrl =
      tokenData.url ||
      tokenData.serverUrl ||
      tokenData.livekitUrl;

    if (!tokenData.token || !liveKitUrl) {
      throw new Error(
        "Сервер не вернул данные LiveKit. Проверь server.js."
      );
    }

    liveRoom = new sdk.Room();

    liveRoom.on(sdk.RoomEvent.TrackSubscribed, (track) => {
      attachTrack(track);
    });

    liveRoom.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
    });

    liveRoom.on(sdk.RoomEvent.Disconnected, () => {
      showMessage("Соединение с эфиром потеряно");
    });

    await liveRoom.connect(liveKitUrl, tokenData.token);

    for (const participant of liveRoom.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) {
          attachTrack(publication.track);
        }
      }
    }
  }

  function addChatMessage(item) {
    if (!chatList) return;

    const row = document.createElement("div");
    row.className = "chat-message";

    const name = document.createElement("strong");
    name.textContent = item.participant_name || "Гость";

    const message = document.createElement("span");
    message.textContent = " " + (item.message || "");

    row.append(name, message);
    chatList.appendChild(row);

    while (chatList.children.length > 100) {
      chatList.firstElementChild.remove();
    }

    chatList.scrollTop = chatList.scrollHeight;
  }

  async function loadChat() {
    if (!roomName || !chatList) return;

    try {
      const data = await api(
        "/api/chat?roomName=" + encodeURIComponent(roomName)
      );

      const messages = Array.isArray(data)
        ? data
        : data.messages || [];

      if (firstChatLoad) {
        chatList.replaceChildren();
        messages.forEach(addChatMessage);
        firstChatLoad = false;
      } else {
        const newMessages = messages.filter((item) => {
          if (lastMessageId === null) return true;

          return Number(item.id) > Number(lastMessageId);
        });

        newMessages.forEach(addChatMessage);
      }

      if (messages.length) {
        lastMessageId = messages[messages.length - 1].id;
      }
    } catch (error) {
      console.error("Ошибка загрузки чата:", error);
    }
  }

  if (chatForm) {
    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const message = chatInput?.value.trim();

      if (!message || !roomName) return;

      try {
        await api("/api/chat", {
          method: "POST",
          body: JSON.stringify({
            roomName,
            participantName: "Гость",
            message
          })
        });

        chatInput.value = "";
        await loadChat();
      } catch (error) {
        showMessage(error.message);
      }
    });
  }

  async function loadWallet() {
    if (!coinBalance) return;

    try {
      const data = await api("/api/wallet");
      coinBalance.textContent = data.balance;
    } catch (error) {
      console.error("Ошибка загрузки баланса:", error);
    }
  }

  async function loadGifts() {
    if (!giftList) return;

    try {
      const data = await api("/api/gifts");

      const gifts = Array.isArray(data)
        ? data
        : data.gifts || [];

      giftList.replaceChildren();

      gifts.forEach((gift) => {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "gift-item";
        button.textContent =
          `${gift.emoji || "🎁"} ${gift.name} — ${gift.price} монет`;

        button.addEventListener("click", () => {
          sendGift(gift.id, button);
        });

        giftList.appendChild(button);
      });
    } catch (error) {
      showMessage("Ошибка загрузки подарков: " + error.message);
    }
  }

  async function sendGift(giftId, button) {
    if (!roomName) return;

    if (button) button.disabled = true;

    try {
      const data = await api("/api/gifts/send", {
        method: "POST",
        body: JSON.stringify({
          roomName,
          giftId
        })
      });

      if (coinBalance && data.balance !== undefined) {
        coinBalance.textContent = data.balance;
      }

      showMessage(
        `${data.emoji || "🎁"} Подарок «${data.gift || "Подарок"}» отправлен!`
      );
    } catch (error) {
      showMessage(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function init() {
    try {
      await connectLive();
    } catch (error) {
      console.error("Ошибка подключения к эфиру:", error);

      if (titleElement) {
        titleElement.textContent =
          "Ошибка подключения: " + error.message;
      }
    }

    await Promise.all([
      loadChat(),
      loadWallet(),
      loadGifts()
    ]);

    chatTimer = setInterval(loadChat, 3000);
  }

  window.addEventListener("beforeunload", () => {
    clearInterval(chatTimer);

    if (liveRoom) {
      liveRoom.disconnect();
    }
  });

  init();
})();
