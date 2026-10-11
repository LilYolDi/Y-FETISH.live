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
  const chatList = $("#chatMessages") || $("#messages") || $("#chat");

  let liveRoom = null;
  let chatTimer = null;
  let heartbeatTimer = null;
  let lastMessageId = null;
  let firstChatLoad = true;
  let isHost = false;
  let hostTracks = [];
  let hostFacingMode = "user";
  let hostBusy = false;
  let streamEnded = false;

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
      throw new Error(data.error || `Ошибка сервера: ${response.status}`);
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

  function getVideoContainer() {
    return (
      $("#videoContainer") ||
      $("#liveVideo") ||
      $("#videoPlayer") ||
      $(".video-container") ||
      $("video")?.parentElement
    );
  }

  function attachTrack(track) {
    const container = getVideoContainer();
    if (!container || !track) return;

    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;

    if (track.kind === "video") {
      element.style.width = "100%";
      element.style.height = "100%";
      element.style.objectFit = "cover";
      element.style.display = "block";

      if (isHost) element.muted = true;
    }

    if (track.kind === "audio") {
      element.style.display = "none";
    }

    container.appendChild(element);
  }

  async function loadStreamInfo() {
    const data = await api("/api/streams");
    const streams = Array.isArray(data) ? data : data.streams || [];

    const stream = streams.find(
      (item) => item.room_name === roomName && item.status === "live"
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
      hostNameElement.textContent = stream.host_name || "Ведущий";
    }

    return true;
  }

  async function sendHostHeartbeat() {
    if (!isHost || !roomName || streamEnded) return;

    try {
      await api("/api/streams/heartbeat", {
        method: "POST",
        body: JSON.stringify({ roomName })
      });
    } catch (error) {
      console.warn("Heartbeat:", error.message);
    }
  }

  function startHostHeartbeat() {
    clearInterval(heartbeatTimer);
    sendHostHeartbeat();
    heartbeatTimer = setInterval(sendHostHeartbeat, 15000);
  }

  function setupHostInterface() {
    if ($("#hostLiveControls")) return;

    document.body.classList.add("host-broadcast-mode");

    const style = document.createElement("style");
    style.textContent = `
      body.host-broadcast-mode {
        margin: 0;
        background: #080808;
      }

      body.host-broadcast-mode #videoContainer,
      body.host-broadcast-mode #liveVideo,
      body.host-broadcast-mode #videoPlayer,
      body.host-broadcast-mode .video-container {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        max-width: none;
        margin: 0;
        padding: 0;
        background: #080808;
        z-index: 1;
      }

      body.host-broadcast-mode video {
        width: 100%;
        height: 100%;
        object-fit: cover !important;
      }

      #hostLiveControls {
        position: fixed;
        z-index: 9999;
        left: 12px;
        right: 12px;
        bottom: calc(14px + env(safe-area-inset-bottom, 0px));
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
        gap: 8px;
      }

      #hostLiveControls button {
        min-height: 44px;
        padding: 11px 15px;
        border: 0;
        border-radius: 10px;
        background: #e21b2d;
        color: white;
        font-weight: 700;
        cursor: pointer;
      }

      #hostLiveControls .secondary {
        background: #303030;
      }
    `;
    document.head.appendChild(style);

    const controls = document.createElement("div");
    controls.id = "hostLiveControls";

    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "secondary";
    switchButton.textContent = "Переключить камеру";
    switchButton.addEventListener("click", switchHostCamera);

    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.textContent = "Завершить эфир";
    stopButton.addEventListener("click", stopHostStream);

    controls.append(switchButton, stopButton);
    document.body.appendChild(controls);
  }

  async function createCameraTrack(sdk, facingMode) {
    const tracks = await sdk.createLocalTracks({
      audio: false,
      video: {
        facingMode,
        resolution: { width: 1280, height: 720 }
      }
    });

    const track = tracks.find((item) => item.kind === "video");

    if (!track) {
      tracks.forEach((item) => item.stop());
      throw new Error("Не удалось включить камеру");
    }

    const capabilities = track.mediaStreamTrack?.getCapabilities?.();

    if (capabilities?.zoom) {
      try {
        await track.mediaStreamTrack.applyConstraints({
          advanced: [{ zoom: capabilities.zoom.min ?? 1 }]
        });
      } catch (_) {}
    }

    return track;
  }

  async function publishHostTracks(sdk) {
    const tracks = await sdk.createLocalTracks({
      audio: true,
      video: {
        facingMode: hostFacingMode,
        resolution: { width: 1280, height: 720 }
      }
    });

    try {
      for (const track of tracks) {
        if (track.kind === "video") {
          const capabilities =
            track.mediaStreamTrack?.getCapabilities?.();

          if (capabilities?.zoom) {
            try {
              await track.mediaStreamTrack.applyConstraints({
                advanced: [{ zoom: capabilities.zoom.min ?? 1 }]
              });
            } catch (_) {}
          }
        }

        await liveRoom.localParticipant.publishTrack(track);
        hostTracks.push(track);

        if (track.kind === "video") {
          attachTrack(track);
        }
      }
    } catch (error) {
      tracks.forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
      throw error;
    }
  }

  async function switchHostCamera() {
    if (!liveRoom || !isHost || hostBusy || streamEnded) return;

    hostBusy = true;

    try {
      const sdk = await loadLiveKit();
      const nextMode =
        hostFacingMode === "user" ? "environment" : "user";

      const newTrack = await createCameraTrack(sdk, nextMode);
      const oldTracks = hostTracks.filter((track) => track.kind === "video");

      for (const track of oldTracks) {
        try {
          await liveRoom.localParticipant.unpublishTrack(track);
          track.detach().forEach((element) => element.remove());
          track.stop();
        } catch (_) {}
      }

      hostTracks = hostTracks.filter((track) => track.kind !== "video");

      await liveRoom.localParticipant.publishTrack(newTrack);
      hostTracks.push(newTrack);
      hostFacingMode = nextMode;
      attachTrack(newTrack);

      showMessage("Камера переключена.");
    } catch (error) {
      showMessage("Не удалось переключить камеру: " + error.message);
    } finally {
      hostBusy = false;
    }
  }

  async function disconnectLiveRoom() {
    const room = liveRoom;
    liveRoom = null;

    if (room) {
      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch (_) {}

      try {
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch (_) {}

      try {
        await room.disconnect();
      } catch (_) {}
    }

    hostTracks.forEach((track) => {
      try {
        track.detach().forEach((element) => element.remove());
        track.stop();
      } catch (_) {}
    });

    hostTracks = [];
  }

  async function stopHostStream() {
    if (!isHost || hostBusy || streamEnded) return;

    if (!window.confirm("Завершить эфир и отключить камеру и микрофон?")) {
      return;
    }

    hostBusy = true;

    const controls = $("#hostLiveControls");
    const buttons = controls?.querySelectorAll("button");
    buttons?.forEach((button) => {
      button.disabled = true;
    });

    showMessage("Завершение эфира...");

    try {
      await disconnectLiveRoom();

      await api("/api/streams/stop", {
        method: "POST",
        body: JSON.stringify({ roomName })
      });

      streamEnded = true;
      clearInterval(chatTimer);
      clearInterval(heartbeatTimer);
      window.location.replace("/");
    } catch (error) {
      showMessage(
        "Не удалось подтвердить завершение эфира: " + error.message
      );

      window.setTimeout(() => {
        window.location.replace("/");
      }, 1800);
    } finally {
      hostBusy = false;
    }
  }

  function setupViewerRoomEvents(sdk) {
    liveRoom.on(sdk.RoomEvent.TrackSubscribed, (track) => {
      attachTrack(track);
    });

    liveRoom.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
    });

    liveRoom.on(sdk.RoomEvent.Disconnected, () => {
      if (!streamEnded) {
        showMessage("Соединение с эфиром потеряно.");
      }
    });
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
      "/api/livekit/token?roomName=" + encodeURIComponent(roomName)
    );

    const liveKitUrl =
      tokenData.url || tokenData.serverUrl || tokenData.livekitUrl;

    if (!tokenData.token || !liveKitUrl) {
      throw new Error("Сервер не вернул данные LiveKit.");
    }

    isHost = tokenData.isHost === true;
    liveRoom = new sdk.Room();
    setupViewerRoomEvents(sdk);

    await liveRoom.connect(liveKitUrl, tokenData.token);

    if (isHost) {
      setupHostInterface();
      await publishHostTracks(sdk);
      startHostHeartbeat();
    } else {
      for (const participant of liveRoom.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track) attachTrack(publication.track);
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
    if (!roomName || !chatList || streamEnded) return;

    try {
      const data = await api(
        "/api/chat?roomName=" + encodeURIComponent(roomName)
      );

      const messages = Array.isArray(data) ? data : data.messages || [];

      if (firstChatLoad) {
        chatList.replaceChildren();
        messages.forEach(addChatMessage);
        firstChatLoad = false;
      } else {
        const newMessages = messages.filter(
          (item) =>
            lastMessageId === null ||
            Number(item.id) > Number(lastMessageId)
        );

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
      if (!message || !roomName || streamEnded) return;

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
      coinBalance.textContent = data.balance ?? 0;
    } catch (error) {
      console.error("Ошибка загрузки баланса:", error);
    }
  }

  async function loadGifts() {
    if (!giftList) return;

    try {
      const data = await api("/api/gifts");
      const gifts = Array.isArray(data) ? data : data.gifts || [];

      giftList.replaceChildren();

      gifts.forEach((gift) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gift-item";
        button.textContent =
          `${gift.emoji || "🎁"} ${gift.name} — ${gift.price} монет`;

        button.addEventListener("click", () => sendGift(gift.id, button));
        giftList.appendChild(button);
      });
    } catch (error) {
      showMessage("Ошибка загрузки подарков: " + error.message);
    }
  }

  async function sendGift(giftId, button) {
    if (!roomName || streamEnded) return;
    if (button) button.disabled = true;

    try {
      const data = await api("/api/gifts/send", {
        method: "POST",
        body: JSON.stringify({ roomName, giftId })
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
        titleElement.textContent = "Ошибка подключения: " + error.message;
      }

      if (isHost && liveRoom) {
        await disconnectLiveRoom();

        try {
          await api("/api/streams/stop", {
            method: "POST",
            body: JSON.stringify({ roomName })
          });
        } catch (stopError) {
          console.error("Не удалось закрыть эфир:", stopError);
        }
      }
    }

    await Promise.all([loadChat(), loadWallet(), loadGifts()]);
    chatTimer = setInterval(loadChat, 3000);
  }

  window.addEventListener("beforeunload", () => {
    clearInterval(chatTimer);
    clearInterval(heartbeatTimer);

    if (liveRoom) {
      liveRoom.disconnect();
    }

    hostTracks.forEach((track) => {
      try {
        track.stop();
      } catch (_) {}
    });
  });

  init();
})();
