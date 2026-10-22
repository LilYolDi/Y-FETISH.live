
(() => {
  "use strict";

  const SUPABASE_URL = "https://cdyuxiicllnfrwssigsr.supabase.co";
  const SUPABASE_KEY = "sb_publishable_VuAtnZ0pGWc4BOsYTLBfeA_1Mb86lw0";

  const $ = (id) => document.getElementById(id);
  const standalone = Boolean($("messagesPageNotice"));

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function addPageStyles() {
    if ($("messagesStandaloneStyles")) return;

    const style = document.createElement("style");
    style.id = "messagesStandaloneStyles";
    style.textContent = `
      .messages-app { display:flex; flex-direction:column; gap:14px; margin-top:22px; }
      .messages-search-form { display:flex; gap:8px; }
      .messages-search-form input {
        min-width:0; flex:1; padding:13px 14px; color:#fff;
        background:#222; border:1px solid #383838; border-radius:12px; outline:none;
      }
      .messages-search-form input:focus { border-color:#ff263f; }
      .messages-search-form button, .messages-send-button {
        padding:12px 16px; border:0; border-radius:12px;
        background:#ff263f; color:#fff; font-weight:700; cursor:pointer;
      }
      .messages-app-layout {
        display:grid; grid-template-columns:minmax(0, .85fr) minmax(0, 1.4fr);
        min-height:480px; border:1px solid #333; border-radius:16px;
        overflow:hidden; background:#171717;
      }
      .messages-sidebar { min-width:0; border-right:1px solid #333; }
      .messages-sidebar-title { margin:0; padding:16px; border-bottom:1px solid #303030; font-size:15px; }
      .messages-conversations { min-height:100px; max-height:520px; overflow-y:auto; }
      .messages-conversation {
        width:100%; display:flex; justify-content:space-between; align-items:center;
        gap:10px; padding:14px; border:0; border-bottom:1px solid #292929;
        background:transparent; color:#fff; text-align:left; cursor:pointer;
      }
      .messages-conversation:hover, .messages-conversation.active { background:#292020; }
      .messages-conversation-details { display:flex; flex:1; flex-direction:column; gap:5px; min-width:0; }
      .messages-conversation-name { color:#fff; font-weight:700; overflow-wrap:anywhere; }
      .messages-conversation-last { color:#999; font-size:12px; overflow:hidden; text-overflow:ellipsis; }
      .messages-conversation-meta { display:flex; align-items:center; flex-direction:column; gap:6px; color:#888; font-size:11px; }
      .messages-unread { display:grid; place-items:center; min-width:20px; height:20px; padding:0 5px; border-radius:20px; background:#ff263f; color:#fff; }
      .messages-search-open { color:#ff5366; font-size:12px; white-space:nowrap; }
      .messages-chat { display:flex; flex-direction:column; min-width:0; min-height:480px; }
      .messages-chat-header { padding:16px; border-bottom:1px solid #303030; font-weight:800; overflow-wrap:anywhere; }
      .messages-status { padding:8px 12px; color:#aaa; font-size:12px; line-height:1.5; }
      .messages-history {
        display:flex; flex:1; flex-direction:column; gap:12px; min-height:250px;
        max-height:440px; padding:14px; overflow-y:auto;
      }
      .messages-message { max-width:88%; align-self:flex-start; }
      .messages-message.own { align-self:flex-end; }
      .messages-message-body { padding:10px 12px; border:1px solid #383838; border-radius:14px 14px 14px 4px; background:#252525; overflow-wrap:anywhere; }
      .messages-message.own .messages-message-body { border-color:#762330; background:#421923; border-radius:14px 14px 4px 14px; }
      .messages-message-text { margin:0; white-space:pre-wrap; line-height:1.5; }
      .messages-message-meta { margin-top:5px; color:#888; font-size:10px; text-align:right; }
      .messages-media-image { display:block; max-width:min(240px,65vw); max-height:280px; object-fit:contain; border-radius:10px; cursor:zoom-in; }
      .messages-media-video { display:block; width:min(260px,65vw); max-height:260px; border-radius:10px; background:#000; }
      .messages-compose { display:flex; flex-direction:column; gap:9px; padding:12px; border-top:1px solid #333; }
      .messages-compose textarea { width:100%; min-height:72px; resize:vertical; padding:12px; color:#fff; background:#222; border:1px solid #393939; border-radius:12px; }
      .messages-compose-bottom { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
      .messages-compose input[type=file] { min-width:0; max-width:100%; color:#aaa; font-size:12px; }
      .messages-send-button:disabled { opacity:.55; cursor:wait; }
      .messages-muted { padding:16px; color:#999; font-size:13px; line-height:1.6; }
      .messages-error { color:#ff7887; font-size:13px; }
   
      @media (max-width: 650px) {
        .messages-app {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          flex-direction: column;
          gap: 0;
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100vh;
          height: 100dvh;
          background: #151515;
          overflow: hidden;
        }

        .messages-app-layout {
          display: flex;
          flex: 1;
          flex-direction: column;
          min-height: 0;
          height: auto;
          border: 0;
          border-radius: 0;
          overflow: hidden;
        }

        .messages-app-layout.chat-open .messages-sidebar {
          display: none;
        }

        .messages-app-layout.chat-open .messages-chat {
          display: flex;
        }

        .messages-sidebar {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          border: 0;
          overflow: hidden;
        }

        .messages-conversations {
          flex: 1;
          min-height: 0;
          max-height: none;
          overflow-y: auto;
          padding-bottom: env(safe-area-inset-bottom);
        }

        .messages-chat {
          display: none;
          flex: 1;
          flex-direction: column;
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }

        .messages-chat-header {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-shrink: 0;
          padding: calc(10px + env(safe-area-inset-top)) 14px 10px;
        }

        .messages-chat-back {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          border: 1px solid #444;
          border-radius: 12px;
          background: #252525;
          color: #fff;
          font-size: 27px;
          cursor: pointer;
        }

        .messages-chat-name {
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .messages-history {
          flex: 1;
          min-height: 0;
          max-height: none;
          overflow-y: auto;
        }

        .messages-compose {
          flex-shrink: 0;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
        }

        .messages-compose textarea {
          min-height: 56px;
          max-height: 120px;
          resize: none;
        }

        .messages-search-form {
          flex-shrink: 0;
          padding: 10px 12px;
          background: #151515;
        }

        .messages-search-form button {
          padding: 12px;
        }
      }

      @media (min-width: 651px) {
        .messages-chat-back {
          display: none;
        }
      }

      }
    `;
    document.head.append(style);
  }

  function buildStandaloneInterface() {
    const content = document.querySelector(".messages-page-content");
    if (!content) return;

    addPageStyles();

    content.replaceChildren();

    const heading = createElement("h1", "messages-heading", "Личные сообщения");
    const description = createElement(
      "p",
      "messages-description",
      "Находи пользователей и общайся в личных переписках."
    );

    const app = createElement("div", "messages-app");

    const searchForm = createElement("form", "messages-search-form");
    searchForm.id = "messagesSearchForm";

    const searchInput = createElement("input");
    searchInput.id = "messagesSearchInput";
    searchInput.type = "search";
    searchInput.placeholder = "Поиск пользователей…";
    searchInput.autocomplete = "off";
    searchInput.setAttribute("aria-label", "Поиск пользователей");

    const searchButton = createElement("button", "", "Найти");
    searchButton.type = "submit";
    searchForm.append(searchInput, searchButton);

    const layout = createElement("div", "messages-app-layout");

    const sidebar = createElement("section", "messages-sidebar");
    sidebar.append(createElement("h2", "messages-sidebar-title", "Переписки"));

    const conversations = createElement("div", "messages-conversations");
    conversations.id = "messagesConversations";
    conversations.append(
      createElement("p", "messages-muted", "Загружаем переписки…")
    );
    sidebar.append(conversations);

    
    const chat = createElement("section", "messages-chat");
    const currentUser = createElement("div", "messages-chat-header");
    currentUser.id = "messagesCurrentUser";

    const chatBackButton = createElement("button", "messages-chat-back", "‹");
    chatBackButton.type = "button";
    chatBackButton.setAttribute(
      "aria-label",
      "Вернуться к списку переписок"
    );

    const currentUserName = createElement(
      "span",
      "messages-chat-name",
      "Выбери пользователя"
    );
    currentUserName.id = "messagesCurrentUserName";

    currentUser.append(chatBackButton, currentUserName);


    const status = createElement("div", "messages-status");
    status.id = "messagesStatus";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const history = createElement("div", "messages-history");
    history.id = "messagesHistory";
    history.append(
      createElement("p", "messages-muted", "Открой переписку, чтобы увидеть сообщения.")
    );

    const compose = createElement("form", "messages-compose");
    compose.id = "messagesCompose";
    compose.hidden = true;

    const messageInput = createElement("textarea");
    messageInput.id = "messagesText";
    messageInput.maxLength = 2000;
    messageInput.placeholder = "Напиши сообщение…";
    messageInput.setAttribute("aria-label", "Текст сообщения");

    const bottom = createElement("div", "messages-compose-bottom");

    const fileInput = createElement("input");
    fileInput.id = "messagesFile";
    fileInput.type = "file";
    fileInput.accept = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime";
    fileInput.setAttribute("aria-label", "Прикрепить фото или видео");

    const sendButton = createElement("button", "messages-send-button", "Отправить");
    sendButton.id = "messagesSend";
    sendButton.type = "submit";

    bottom.append(fileInput, sendButton);
    compose.append(messageInput, bottom);

    chat.append(currentUser, status, history, compose);
    layout.append(sidebar, chat);

    app.append(searchForm, layout);
    content.append(heading, description, app);

    // Совместимость с прежней логикой модального окна.
    const compatibility = createElement("div");
    compatibility.hidden = true;
    compatibility.innerHTML = `
      <button type="button" id="messagesButton" hidden></button>
      <span id="messagesBadge" hidden>0</span>
      <div id="messagesModal">
        <button type="button" id="messagesClose"></button>
      </div>
    `;
    document.body.append(compatibility);
  }

  if (standalone) buildStandaloneInterface();

  const button = $("messagesButton");
  const badge = $("messagesBadge");
  const modal = $("messagesModal");
  const closeButton = $("messagesClose");
  const searchForm = $("messagesSearchForm");
  const searchInput = $("messagesSearchInput");
  const conversationsBox = $("messagesConversations");
  const statusBox = $("messagesStatus");
  const currentUserBox = $("messagesCurrentUser");
  const currentUserName = $("messagesCurrentUserName");
  const appLayout = document.querySelector(".messages-app-layout");
  const chatBackButton = document.querySelector(".messages-chat-back");
  const historyBox = $("messagesHistory");
  const composeForm = $("messagesCompose");
  const messageInput = $("messagesText");
  const fileInput = $("messagesFile");
  const sendButton = $("messagesSend");

  if (
    !button || !modal || !closeButton || !searchForm || !searchInput ||
    !conversationsBox || !currentUserBox || !historyBox || !composeForm ||
    !messageInput || !fileInput || !sendButton
  ) {
    console.error("Личные сообщения: не найдены необходимые элементы.");
    return;
  }

  function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = () => window.supabase?.createClient
        ? resolve()
        : reject(new Error("Не удалось загрузить Supabase."));
      script.onerror = () => reject(new Error("Не удалось загрузить библиотеку Supabase."));
      document.head.append(script);
    });
  }

  const state = {
    user: null,
    activeUser: null,
    conversations: [],
    unreadTotal: 0,
    sending: false,
    searchRequest: 0,
    historyRequest: 0,
    refreshTimer: null
  };

  let supabaseClient;

  function setStatus(message) {
    if (statusBox) statusBox.textContent = message || "";
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function getAccessToken() {
    const { data, error } = await supabaseClient.auth.getSession();

    if (error) throw new Error("Не удалось проверить авторизацию.");

    const session = data?.session;

    if (!session?.access_token || !session?.user) {
      state.user = null;
      throw new Error("Войди в свой аккаунт, чтобы продолжить.");
    }

    state.user = session.user;
    return session.access_token;
  }

  async function loadSession() {
    try {
      await getAccessToken();
      return state.user;
    } catch {
      state.user = null;
      return null;
    }
  }

  async function apiRequest(path, options = {}) {
    const token = await getAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    if (options.body && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin"
    });

    let result = {};
    try {
      result = await response.json();
    } catch {}

    if (!response.ok) {
      if (response.status === 401) state.user = null;
      throw new Error(
        result.error || result.message || `Ошибка запроса (${response.status}).`
      );
    }

    return result;
  }

  function updateBadge() {
    if (!badge) return;
    const total = Number(state.unreadTotal) || 0;
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.hidden = total <= 0;
  }

  function updateUnreadCount() {
    state.unreadTotal = state.conversations.reduce(
      (sum, conversation) => sum + (Number(conversation.unread) || 0),
      0
    );
    updateBadge();
  }

  function renderConversations() {
    conversationsBox.replaceChildren();

    if (!state.conversations.length) {
      conversationsBox.append(
        createElement("p", "messages-muted", "Пока нет переписок. Найди пользователя через поиск.")
      );
      return;
    }

    for (const conversation of state.conversations) {
      const userId = conversation.userId;
      if (!userId) continue;

      const item = createElement("button", "messages-conversation");
      item.type = "button";
      item.dataset.userId = userId;

      if (state.activeUser?.id === userId) item.classList.add("active");

      const details = createElement("span", "messages-conversation-details");
      const name = createElement(
        "span",
        "messages-conversation-name",
        conversation.nickname || "Пользователь"
      );
      const last = createElement(
        "span",
        "messages-conversation-last",
        conversation.lastMessage || "Начни переписку"
      );

      const meta = createElement("span", "messages-conversation-meta");
      meta.append(createElement("span", "", formatDate(conversation.lastMessageAt)));

      if (Number(conversation.unread) > 0) {
        meta.append(createElement("span", "messages-unread", String(conversation.unread)));
      }

      details.append(name, last);
      item.append(details, meta);

      item.addEventListener("click", () => {
        openConversation({
          id: userId,
          nickname: conversation.nickname || "Пользователь"
        });
      });

      conversationsBox.append(item);
    }
  }

  async function loadConversations() {
    if (!state.user && !await loadSession()) {
      setStatus("Войди в аккаунт, чтобы открыть переписки.");
      return;
    }

    setStatus("Загружаем переписки…");

    try {
      const result = await apiRequest("/api/chats/conversations");
      state.conversations = Array.isArray(result.conversations)
        ? result.conversations
        : [];

      updateUnreadCount();
      renderConversations();
      setStatus("");

      if (state.activeUser) {
        const conversation = state.conversations.find(
          item => item.userId === state.activeUser.id
        );
        if (conversation) {
          state.activeUser.nickname = conversation.nickname || state.activeUser.nickname;
          currentUserBox.textContent = state.activeUser.nickname;
        }
      }
    } catch (error) {
      setStatus(error.message || "Не удалось загрузить переписки.");
    }
  }

  async function searchUsers(query) {
    const requestId = ++state.searchRequest;
    const value = query.trim();

    if (value.length < 2) {
      renderConversations();
      setStatus(value ? "Введи минимум 2 символа для поиска." : "");
      return;
    }

    setStatus("Ищем пользователей…");

    try {
      const result = await apiRequest(
        `/api/chats/users?q=${encodeURIComponent(value)}`
      );

      if (requestId !== state.searchRequest) return;

      const users = Array.isArray(result.users) ? result.users : [];
      conversationsBox.replaceChildren();

      const filtered = users.filter(user => user.id && user.id !== state.user?.id);

      if (!filtered.length) {
        setStatus("Пользователи не найдены.");
        return;
      }

      setStatus(`Найдено пользователей: ${filtered.length}`);

      for (const user of filtered) {
        const item = createElement("button", "messages-conversation messages-search-result");
        item.type = "button";

        const details = createElement("span", "messages-conversation-details");
        details.append(createElement(
          "span",
          "messages-conversation-name",
          user.nickname || "Пользователь"
        ));

        item.append(details, createElement("span", "messages-search-open", "Написать"));
        item.addEventListener("click", () => openConversation({
          id: user.id,
          nickname: user.nickname || "Пользователь"
        }));
        conversationsBox.append(item);
      }
    } catch (error) {
      if (requestId === state.searchRequest) {
        setStatus(error.message || "Не удалось выполнить поиск.");
      }
    }
  }

  async function openConversation(user) {
    if (!user?.id) return;

    if (!state.user && !await loadSession()) {
      setStatus("Войди в аккаунт, чтобы отправлять сообщения.");
      return;
    }

    if (user.id === state.user?.id) return;

    state.activeUser = {
      id: user.id,
      nickname: user.nickname || "Пользователь"
    };

    currentUserBox.textContent = state.activeUser.nickname;
    composeForm.hidden = false;
    messageInput.value = "";
    fileInput.value = "";

    renderConversations();
    await loadHistory();
    messageInput.focus();
  }

  function renderMessage(message) {
    const own = message.sender_id === state.user?.id;
    const item = createElement("article", own ? "messages-message own" : "messages-message");
    const body = createElement("div", "messages-message-body");

    if (message.body) {
      body.append(createElement("p", "messages-message-text", message.body));
    }

    if (message.media_url) {
      if (message.media_type === "image") {
        const image = document.createElement("img");
        image.src = message.media_url;
        image.alt = "Фото в сообщении";
        image.loading = "lazy";
        image.className = "messages-media-image";
        image.referrerPolicy = "no-referrer";

        image.addEventListener("click", () => {
          const viewer = createElement("div");
          viewer.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out";

          const fullImage = document.createElement("img");
          fullImage.src = image.src;
          fullImage.alt = image.alt;
          fullImage.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;border-radius:8px";

          viewer.append(fullImage);
          viewer.addEventListener("click", () => viewer.remove());
          document.body.append(viewer);
        });

        body.append(image);
      } else if (message.media_type === "video") {
        const video = document.createElement("video");
        video.src = message.media_url;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.className = "messages-media-video";
        body.append(video);
      }
    }

    const meta = createElement("div", "messages-message-meta", formatDate(message.created_at));

    if (own && message.read_at) {
      meta.append(createElement("span", "messages-read-mark", " · Прочитано"));
    }

    item.append(body, meta);
    return item;
  }

  async function loadHistory() {
    const active = state.activeUser;
    if (!active) return;

    const requestId = ++state.historyRequest;
    const userId = active.id;

    historyBox.replaceChildren(createElement("p", "messages-muted", "Загружаем сообщения…"));

    try {
      const result = await apiRequest(
        `/api/chats/${encodeURIComponent(userId)}/messages`
      );

      if (requestId !== state.historyRequest || state.activeUser?.id !== userId) return;

      const messages = Array.isArray(result.messages) ? result.messages : [];
      historyBox.replaceChildren();

      if (!messages.length) {
        historyBox.append(createElement("p", "messages-muted", "Сообщений пока нет. Напиши первым!"));
      } else {
        for (const message of messages) historyBox.append(renderMessage(message));
      }

      historyBox.scrollTop = historyBox.scrollHeight;

      const conversation = state.conversations.find(item => item.userId === userId);
      if (conversation) {
        conversation.unread = 0;
        updateUnreadCount();
        renderConversations();
      }
    } catch (error) {
      if (requestId !== state.historyRequest) return;
      historyBox.replaceChildren(
        createElement("p", "messages-error", error.message || "Не удалось загрузить сообщения.")
      );
    }
  }

  async function uploadMedia(file) {
    const allowedTypes = [
      "image/jpeg", "image/png", "image/webp", "image/gif",
      "video/mp4", "video/webm", "video/quicktime"
    ];

    if (!allowedTypes.includes(file.type)) {
      throw new Error("Поддерживаются JPG, PNG, WEBP, GIF, MP4, WEBM и MOV.");
    }

    const isImage = file.type.startsWith("image/");
    const maxSize = isImage ? 15 * 1024 * 1024 : 100 * 1024 * 1024;

    if (file.size <= 0 || file.size > maxSize) {
      throw new Error(isImage
        ? "Максимальный размер фото — 15 МБ."
        : "Максимальный размер видео — 100 МБ.");
    }

    const prepared = await apiRequest("/api/chats/media-upload", {
      method: "POST",
      body: JSON.stringify({ mimeType: file.type, size: file.size })
    });

    if (!prepared.path || !prepared.token) {
      throw new Error("Сервер не подготовил загрузку файла.");
    }

    const { error } = await supabaseClient.storage
      .from("chat-media")
      .uploadToSignedUrl(prepared.path, prepared.token, file, {
        contentType: file.type,
        upsert: false
      });

    if (error) throw new Error(error.message || "Не удалось загрузить файл.");

    return {
      mediaPath: prepared.path,
      mediaType: prepared.mediaType
    };
  }

  async function sendMessage(event) {
    event.preventDefault();

    if (state.sending || !state.activeUser) return;

    const body = messageInput.value.trim();
    const file = fileInput.files?.[0] || null;

    if (!body && !file) {
      messageInput.focus();
      return;
    }

    if (body.length > 2000) {
      alert("Максимальная длина сообщения — 2000 символов.");
      return;
    }

    state.sending = true;
    sendButton.disabled = true;
    const originalLabel = sendButton.textContent;
    sendButton.textContent = "Отправка…";

    try {
      let media = {};
      if (file) media = await uploadMedia(file);

      const result = await apiRequest(
        `/api/chats/${encodeURIComponent(state.activeUser.id)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            mediaPath: media.mediaPath || "",
            mediaType: media.mediaType || ""
          })
        }
      );

      if (!result.success || !result.message) {
        throw new Error("Сервер не подтвердил отправку сообщения.");
      }

      messageInput.value = "";
      fileInput.value = "";
      await loadHistory();
      await loadConversations();
    } catch (error) {
      alert(error.message || "Не удалось отправить сообщение.");
    } finally {
      state.sending = false;
      sendButton.disabled = false;
      sendButton.textContent = originalLabel;
    }
  }

  function showModal() {
    if (standalone) return;

    modal.hidden = false;
    document.body.classList.add("messages-open");

    loadSession().then(user => {
      if (!user) {
        setStatus("Войди в аккаунт, чтобы пользоваться сообщениями.");
        return;
      }
      loadConversations();
      searchInput.focus();
    });
  }

  function hideModal() {
    if (standalone) return;
    modal.hidden = true;
    document.body.classList.remove("messages-open");
  }

  button.addEventListener("click", showModal);
  closeButton.addEventListener("click", hideModal);

  if (!standalone) {
    modal.addEventListener("click", event => {
      if (event.target === modal) hideModal();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !modal.hidden) hideModal();
    });
  }

  searchForm.addEventListener("submit", event => {
    event.preventDefault();
    searchUsers(searchInput.value);
  });

  searchInput.addEventListener("input", () => {
    if (searchInput.value.trim().length < 2) {
      state.searchRequest++;
      renderConversations();
      setStatus("");
    }
  });

  composeForm.addEventListener("submit", sendMessage);

  async function initialize() {
    try {
      await loadSupabaseLibrary();

      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

      supabaseClient.auth.onAuthStateChange((_event, session) => {
        state.user = session?.user || null;

        if (!state.user) {
          state.activeUser = null;
          state.conversations = [];
          state.unreadTotal = 0;
          updateBadge();
          historyBox.replaceChildren();
          conversationsBox.replaceChildren();
          composeForm.hidden = true;
          currentUserBox.textContent = "Выбери пользователя";
          setStatus("Войди в аккаунт, чтобы открыть личные сообщения.");
        } else {
          loadConversations();
        }
      });

      const user = await loadSession();

      if (!user) {
        setStatus("Для личных сообщений войди в свой аккаунт.");
        if (standalone) {
          conversationsBox.replaceChildren(
            createElement("p", "messages-muted", "Войди в аккаунт, чтобы увидеть переписки.")
          );
        }
        return;
      }

      button.hidden = false;
      await loadConversations();

      // Обновляем открытый чат, чтобы получать новые сообщения без перезагрузки.
      state.refreshTimer = window.setInterval(() => {
        if (!document.hidden && state.activeUser && !state.sending) {
          loadHistory();
          loadConversations();
        }
      }, 7000);
    } catch (error) {
      console.error("Личные сообщения:", error);
      setStatus(error.message || "Не удалось подключить личные сообщения.");
    }
  }

  initialize();
})();