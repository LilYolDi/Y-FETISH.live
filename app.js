
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
  let viewerAudioMuted = true;
  let chatTimer = null;
  let heartbeatTimer = null;
  let giftTimer = null;
  let lastMessageId = null;
  let firstChatLoad = true;
  let isHost = false;
  let hostTracks = [];
  let hostFacingMode = "user";
  let hostBusy = false;
  let streamEnded = false;

  // Подписки
  let streamHostId = null;
  let currentUserId = null;
  let followButton = null;
  let isFollowing = false;
  let followersCount = 0;
  let followBusy = false;

  let giftAnimationLayer = null;
  let lastGiftPollAt = new Date(Date.now() - 15000).toISOString();
  let giftPollBusy = false;
  const seenGiftEvents = new Set();

  function showMessage(message) {
    if (giftMessage) {
      giftMessage.textContent = message;
    } else {
      console.log(message);
    }
  }

  const SUPABASE_URL =
    "https://cdyuxiicllnfrwssigsr.supabase.co";
  const SUPABASE_KEY =
    "sb_publishable_VuAtnZ0pGWc4BOsYTLBfeA_1Mb86lw0";

  const authClient = window.supabase?.createClient
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  async function getAccessToken() {
    if (!authClient) {
      throw new Error("Не удалось подключить сервис аккаунта.");
    }

    const { data, error } = await authClient.auth.getSession();

    if (error) {
      throw new Error("Не удалось проверить вход в аккаунт.");
    }

    const session = data?.session;

    if (!session?.access_token) {
      throw new Error("Войди в аккаунт, чтобы пользоваться подписками и подарками.");
    }

    currentUserId = session.user?.id || currentUserId;
    return session.access_token;
  }

  async function api(url, options = {}) {
    const headers = {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };

    const needsAuth =
      url === "/api/account/wallet" ||
      url === "/api/gifts/send" ||
      url.startsWith("/api/follows/");

    if (needsAuth) {
      headers.Authorization = "Bearer " + await getAccessToken();
    }

    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers
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
      element.muted = isHost || viewerAudioMuted;
    }

    container.appendChild(element);

    if (giftAnimationLayer && giftAnimationLayer.parentElement !== container) {
      container.appendChild(giftAnimationLayer);
    }
  }

  // Оформление подписки
  function setupFollowStyles() {
    if (document.getElementById("followButtonStyles")) return;

    const style = document.createElement("style");
    style.id = "followButtonStyles";
    style.textContent = `
      .live-follow-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 38px;
        margin: 8px 0;
        padding: 9px 16px;
        border: 0;
        border-radius: 10px;
        background: #e21b2d;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      .live-follow-button.is-following {
        background: #303030;
        border: 1px solid #555;
      }

      .live-follow-button:disabled {
        opacity: .65;
        cursor: wait;
      }
    `;
    document.head.appendChild(style);
  }

  function updateFollowButton() {
    if (!followButton) return;

    if (isFollowing) {
      followButton.textContent =
        `✓ Вы подписаны${followersCount > 0 ? ` · ${followersCount}` : ""}`;
      followButton.classList.add("is-following");
      followButton.setAttribute("aria-pressed", "true");
    } else {
      followButton.textContent =
        `❤️ Подписаться${followersCount > 0 ? ` · ${followersCount}` : ""}`;
      followButton.classList.remove("is-following");
      followButton.setAttribute("aria-pressed", "false");
    }
  }

  function createFollowButton() {
    if (followButton || !hostNameElement || !streamHostId) return;

    setupFollowStyles();

    followButton = document.createElement("button");
    followButton.type = "button";
    followButton.className = "live-follow-button";
    followButton.textContent = "❤️ Подписаться";
    followButton.setAttribute("aria-pressed", "false");

    hostNameElement.insertAdjacentElement("afterend", followButton);

    followButton.addEventListener("click", toggleFollow);
  }

  async function loadFollowStatus() {
    if (!streamHostId || !authClient) return;

    try {
      const { data, error } = await authClient.auth.getSession();

      if (error) throw error;

      currentUserId = data?.session?.user?.id || null;

      // Нельзя подписаться на самого себя.
      if (currentUserId && currentUserId === streamHostId) {
        followButton?.remove();
        followButton = null;
        return;
      }

      createFollowButton();

      if (!currentUserId) {
        updateFollowButton();
        return;
      }

      const dataFromApi = await api(
        "/api/follows/" + encodeURIComponent(streamHostId)
      );

      isFollowing = dataFromApi.isFollowing === true;
      followersCount = Number(dataFromApi.followersCount) || 0;

      updateFollowButton();
    } catch (error) {
      console.warn("Не удалось загрузить подписку:", error.message);
      createFollowButton();
      updateFollowButton();
    }
  }

  async function toggleFollow() {
    if (followBusy || !streamHostId || !followButton) return;

    followBusy = true;
    followButton.disabled = true;

    try {
      const token = await getAccessToken();

      if (currentUserId === streamHostId) {
        showMessage("Нельзя подписаться на собственный аккаунт.");
        return;
      }

      const method = isFollowing ? "DELETE" : "POST";

      const data = await api(
        "/api/follows/" + encodeURIComponent(streamHostId),
        { method }
      );

      isFollowing = data.isFollowing === true;

      if (isFollowing) {
        followersCount += 1;
        showMessage("Вы подписались на ведущего!");
      } else {
        followersCount = Math.max(0, followersCount - 1);
        showMessage("Вы отписались от ведущего.");
      }

      updateFollowButton();
    } catch (error) {
      showMessage(error.message);
    } finally {
      followBusy = false;
      if (followButton) followButton.disabled = false;
    }
  }

  // Создаём слой анимации поверх видео.
  function setupGiftAnimationLayer() {
    const container = getVideoContainer();
    if (!container) return null;

    if (
      giftAnimationLayer &&
      giftAnimationLayer.isConnected &&
      giftAnimationLayer.parentElement === container
    ) {
      return giftAnimationLayer;
    }

    const styleId = "liveGiftAnimationStyles";

    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .live-gift-animation-layer {
          position: absolute;
          inset: 0;
          z-index: 50;
          overflow: hidden;
          pointer-events: none;
          contain: layout paint;
        }

        .live-gift-pop {
          position: absolute;
          left: 50%;
          bottom: 16%;
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
          transform: translate(-50%, 0) scale(.7);
          opacity: 0;
          animation: liveGiftFly 3.4s ease-out forwards;
          box-sizing: border-box;
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
        }

        .live-gift-emoji {
          flex: 0 0 auto;
          font-size: clamp(36px, 9vw, 62px);
          line-height: 1;
          filter: drop-shadow(0 2px 8px rgba(255,80,140,.4));
          animation: liveGiftPulse .65s ease-in-out infinite alternate;
        }

        .live-gift-text {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .live-gift-sender {
          overflow: hidden;
          color: #ffd76a;
          font-size: 13px;
          font-weight: 800;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .live-gift-name {
          overflow-wrap: anywhere;
          font-size: 16px;
          font-weight: 800;
        }

        .live-gift-quantity {
          color: #f5f5f5;
          font-size: 12px;
          font-weight: 600;
        }

        @keyframes liveGiftFly {
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

        @keyframes liveGiftPulse {
          from { transform: scale(.92) rotate(-5deg); }
          to { transform: scale(1.08) rotate(5deg); }
        }

        @media (max-width: 480px) {
          .live-gift-pop {
            bottom: 19%;
            gap: 9px;
            padding: 9px 12px;
          }

          .live-gift-name {
            font-size: 14px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .live-gift-pop {
            animation-duration: 2s;
          }

          .live-gift-emoji {
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

    giftAnimationLayer = document.createElement("div");
    giftAnimationLayer.className = "live-gift-animation-layer";
    giftAnimationLayer.setAttribute("aria-hidden", "true");

    container.appendChild(giftAnimationLayer);
    return giftAnimationLayer;
  }

  function showGiftAnimation(event) {
    const layer = setupGiftAnimationLayer();
    if (!layer || !event) return;

    const gift = event.gift || {};
    const emoji = gift.emoji || event.emoji || "🎁";
    const giftName = gift.name || event.giftName || event.name || "Подарок";
    const senderName =
      event.senderName || event.sender_name || "Гость";
    const quantity = Math.max(1, Number(event.quantity) || 1);

    const pop = document.createElement("div");
    pop.className = "live-gift-pop";

    const emojiElement = document.createElement("div");
    emojiElement.className = "live-gift-emoji";
    emojiElement.textContent = emoji;

    const textElement = document.createElement("div");
    textElement.className = "live-gift-text";

    const senderElement = document.createElement("div");
    senderElement.className = "live-gift-sender";
    senderElement.textContent = senderName + " отправил(а) подарок";

    const nameElement = document.createElement("div");
    nameElement.className = "live-gift-name";
    nameElement.textContent = giftName;

    textElement.append(senderElement, nameElement);

    if (quantity > 1) {
      const quantityElement = document.createElement("div");
      quantityElement.className = "live-gift-quantity";
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

  // Получаем подарки, отправленные в этот эфир.
  async function loadGiftEvents() {
    if (!roomName || streamEnded || giftPollBusy) return;

    giftPollBusy = true;
    const pollStartedAt = new Date().toISOString();

    try {
      const query = new URLSearchParams({
        roomName,
        since: lastGiftPollAt
      });

      const data = await api("/api/gifts/events?" + query.toString());
      const events = Array.isArray(data)
        ? data
        : Array.isArray(data.events)
          ? data.events
          : [];

      events.forEach((event) => {
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
        showGiftAnimation(event);
      });

      if (seenGiftEvents.size > 500) {
        const recentKeys = Array.from(seenGiftEvents).slice(-250);
        seenGiftEvents.clear();
        recentKeys.forEach((key) => seenGiftEvents.add(key));
      }

      lastGiftPollAt = pollStartedAt;
    } catch (error) {
      console.warn("Не удалось загрузить события подарков:", error.message);
    } finally {
      giftPollBusy = false;
    }
  }

  function startGiftEvents() {
    clearInterval(giftTimer);
    setupGiftAnimationLayer();
    loadGiftEvents();
    giftTimer = setInterval(loadGiftEvents, 2500);
  }

  function setupSoundToggle() {
    const button = $("#soundToggle");
    if (!button) return;

    function updateButton() {
      button.textContent = viewerAudioMuted ? "🔇" : "🔊";
      button.setAttribute(
        "aria-label",
        viewerAudioMuted ? "Включить звук" : "Выключить звук"
      );
      button.title = viewerAudioMuted ? "Включить звук" : "Выключить звук";
      button.setAttribute(
        "aria-pressed",
        viewerAudioMuted ? "false" : "true"
      );
    }

    button.addEventListener("click", async () => {
      if (isHost) return;

      viewerAudioMuted = !viewerAudioMuted;

      const container = getVideoContainer();
      const audioElements = container
        ? container.querySelectorAll("audio")
        : [];

      audioElements.forEach((audio) => {
        audio.muted = viewerAudioMuted;

        if (!viewerAudioMuted) {
          const playback = audio.play();

          if (playback && typeof playback.catch === "function") {
            playback.catch(() => {});
          }
        }
      });

      updateButton();
    });

    updateButton();
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

    streamHostId = stream.host_id || null;

    if (streamHostId) {
      await loadFollowStatus();
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
      clearInterval(giftTimer);
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

    const soundButton = $("#soundToggle");
    if (soundButton && isHost) {
      soundButton.style.display = "none";
    }

    liveRoom = new sdk.Room();
    setupViewerRoomEvents(sdk);

    await liveRoom.connect(liveKitUrl, tokenData.token);

    setupGiftAnimationLayer();
    startGiftEvents();

    if (isHost) {
      if (followButton) {
        followButton.remove();
        followButton = null;
      }

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
      const data = await api("/api/account/wallet");
      coinBalance.textContent =
        Number(data.balance ?? 0).toLocaleString("ru-RU");
    } catch (error) {
      console.error("Ошибка загрузки баланса:", error);
      coinBalance.textContent = "—";
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
        coinBalance.textContent =
          Number(data.balance).toLocaleString("ru-RU");
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
    clearInterval(giftTimer);

    if (liveRoom) {
      liveRoom.disconnect();
    }

    hostTracks.forEach((track) => {
      try {
        track.stop();
      } catch (_) {}
    });
  });

  setupSoundToggle();
  init();
})();
