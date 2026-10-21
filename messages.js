
(() => {
  "use strict";

  const SUPABASE_URL = "https://cdyuxiicllnfrwssigsr.supabase.co";
  const SUPABASE_KEY = "sb_publishable_VuAtnZ0pGWc4BOsYTLBfeA_1Mb86lw0";

  const $ = (id) => document.getElementById(id);

  const button = $("messagesButton");
  const badge = $("messagesBadge");
  const modal = $("messagesModal");
  const closeButton = $("messagesClose");
  const searchForm = $("messagesSearchForm");
  const searchInput = $("messagesSearchInput");
  const conversationsBox = $("messagesConversations");
  const statusBox = $("messagesStatus");
  const currentUserBox = $("messagesCurrentUser");
  const historyBox = $("messagesHistory");
  const composeForm = $("messagesCompose");
  const messageInput = $("messagesText");
  const fileInput = $("messagesFile");
  const sendButton = $("messagesSend");

  if (
    !button ||
    !modal ||
    !closeButton ||
    !searchForm ||
    !searchInput ||
    !conversationsBox ||
    !currentUserBox ||
    !historyBox ||
    !composeForm ||
    !messageInput ||
    !fileInput ||
    !sendButton
  ) {
    console.error(
      "Личные сообщения: в index.html не найдены необходимые элементы."
    );
    return;
  }

  if (!window.supabase?.createClient) {
    console.error(
      "Личные сообщения: библиотека Supabase не загружена."
    );
    return;
  }

  const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
  );

  const state = {
    user: null,
    activeUser: null,
    conversations: [],
    unreadTotal: 0,
    loadingMessages: false,
    sending: false,
    searchRequest: 0,
    historyRequest: 0
  };

  function escapeError(error, fallback) {
    return error?.message || fallback;
  }

  function setStatus(message) {
    if (statusBox) {
      statusBox.textContent = message;
    }
  }

  function showModal() {
    modal.hidden = false;
    document.body.classList.add("messages-open");

    if (!state.user) {
      loadSession().then((user) => {
        if (!user) {
          setStatus("Войди в аккаунт, чтобы пользоваться сообщениями.");
          return;
        }

        loadConversations();
      });
      return;
    }

    loadConversations();
    searchInput.focus();
  }

  function hideModal() {
    modal.hidden = true;
    document.body.classList.remove("messages-open");
  }

  async function getAccessToken() {
    const { data, error } = await supabaseClient.auth.getSession();

    if (error) {
      throw new Error("Не удалось проверить авторизацию.");
    }

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

    let result;

    try {
      result = await response.json();
    } catch {
      result = {};
    }

    if (!response.ok) {
      if (response.status === 401) {
        state.user = null;
      }

      throw new Error(
        result.error ||
        result.message ||
        `Ошибка запроса (${response.status}).`
      );
    }

    return result;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
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

  function updateBadge() {
    const total = Number(state.unreadTotal) || 0;

    badge.textContent = total > 99 ? "99+" : String(total);
    badge.hidden = total <= 0;
  }

  function updateUnreadCount() {
    state.unreadTotal = state.conversations.reduce(
      (sum, conversation) => {
        return sum + (Number(conversation.unread) || 0);
      },
      0
    );

    updateBadge();
  }

  function renderConversations() {
    conversationsBox.replaceChildren();

    if (!state.conversations.length) {
      conversationsBox.append(
        createElement(
          "p",
          "muted",
          "Пока нет переписок. Найди пользователя через поиск."
        )
      );
      return;
    }

    for (const conversation of state.conversations) {
      const userId = conversation.userId;

      if (!userId) continue;

      const item = createElement("button", "messages-conversation");
      item.type = "button";
      item.dataset.userId = userId;

      if (state.activeUser?.id === userId) {
        item.classList.add("active");
      }

      const details = createElement("span", "messages-conversation-details");
      const name = createElement(
        "span",
        "messages-conversation-name",
        conversation.nickname || "Пользователь"
      );

      const lastMessage = createElement(
        "span",
        "messages-conversation-last",
        conversation.lastMessage || "Начни переписку"
      );

      const meta = createElement("span", "messages-conversation-meta");
      const time = createElement(
        "span",
        "messages-conversation-time",
        formatDate(conversation.lastMessageAt)
      );

      meta.append(time);

      if (Number(conversation.unread) > 0) {
        meta.append(
          createElement(
            "span",
            "messages-unread",
            String(conversation.unread)
          )
        );
      }

      details.append(name, lastMessage);
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
    if (!state.user) {
      const user = await loadSession();

      if (!user) {
        setStatus("Войди в аккаунт, чтобы открыть переписки.");
        return;
      }
    }

    setStatus("Загружаем переписки…");

    try {
      const result = await apiRequest("/api/chats/conversations");

      state.conversations = Array.isArray(result.conversations)
        ? result.conversations
        : [];

      updateUnreadCount();
      renderConversations();

      if (state.activeUser) {
        const existing = state.conversations.find(
          (item) => item.userId === state.activeUser.id
        );

        if (existing) {
          state.activeUser.nickname =
            existing.nickname || state.activeUser.nickname;
          currentUserBox.textContent = state.activeUser.nickname;
        }
      }
    } catch (error) {
      setStatus(escapeError(error, "Не удалось загрузить переписки."));
    }
  }

  async function searchUsers(query) {
    const requestId = ++state.searchRequest;
    const value = query.trim();

    if (value.length < 2) {
      renderConversations();
      setStatus(
        state.conversations.length
          ? ""
          : "Введи минимум 2 символа для поиска пользователя."
      );
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

      if (!users.length) {
        setStatus("Пользователи не найдены.");
        return;
      }

      setStatus(`Найдено пользователей: ${users.length}`);

      for (const user of users) {
        if (!user.id || user.id === state.user?.id) continue;

        const item = createElement(
          "button",
          "messages-conversation messages-search-result"
        );

        item.type = "button";
        item.append(
          createElement(
            "span",
            "messages-conversation-name",
            user.nickname || "Пользователь"
          ),
          createElement("span", "messages-search-open", "Написать")
        );

        item.addEventListener("click", () => {
          openConversation({
            id: user.id,
            nickname: user.nickname || "Пользователь"
          });
        });

        conversationsBox.append(item);
      }

      if (!conversationsBox.childElementCount) {
        setStatus("Пользователи не найдены.");
      }
    } catch (error) {
      if (requestId !== state.searchRequest) return;

      setStatus(escapeError(error, "Не удалось выполнить поиск."));
    }
  }

  async function openConversation(user) {
    if (!user?.id || user.id === state.user?.id) return;

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
    const item = createElement(
      "article",
      own ? "messages-message own" : "messages-message"
    );

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
  image.style.display = "block";
  image.style.width = "auto";
  image.style.height = "auto";
  image.style.maxWidth = "min(220px, 65vw)";
  image.style.maxHeight = "220px";
  image.style.objectFit = "contain";
  image.style.borderRadius = "10px";
  image.style.cursor = "zoom-in";

  image.addEventListener("click", () => {
    const viewer = document.createElement("div");
    viewer.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:100000",
      "background:rgba(0,0,0,.92)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:12px",
      "box-sizing:border-box",
      "cursor:zoom-out"
    ].join(";");

    const fullImage = document.createElement("img");
    fullImage.src = image.src;
    fullImage.alt = image.alt;
    fullImage.style.cssText = [
      "display:block",
      "max-width:100%",
      "max-height:100%",
      "width:auto",
      "height:auto",
      "object-fit:contain",
      "border-radius:8px"
    ].join(";");

    viewer.append(fullImage);
    viewer.addEventListener("click", () => viewer.remove());
    document.body.append(viewer);
  });

  body.append(image);
}
      
        else if (message.media_type === "video") {
        const video = document.createElement("video");
        video.src = message.media_url;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.className = "messages-media-video";
        body.append(video);
      }
    }

    const meta = createElement(
      "div",
      "messages-message-meta",
      formatDate(message.created_at)
    );

    if (own && message.read_at) {
      meta.append(
        createElement("span", "messages-read-mark", " · Прочитано")
      );
    }

    item.append(body, meta);
    return item;
  }

  async function loadHistory() {
    if (!state.activeUser || state.loadingMessages) return;

    const requestId = ++state.historyRequest;
    const userId = state.activeUser.id;

    state.loadingMessages = true;
    historyBox.replaceChildren(
      createElement("p", "muted", "Загружаем сообщения…")
    );

    try {
      const result = await apiRequest(
        `/api/chats/${encodeURIComponent(userId)}/messages`
      );

      if (
        requestId !== state.historyRequest ||
        state.activeUser?.id !== userId
      ) {
        return;
      }

      const messages = Array.isArray(result.messages)
        ? result.messages
        : [];

      historyBox.replaceChildren();

      if (!messages.length) {
        historyBox.append(
          createElement(
            "p",
            "muted",
            "Сообщений пока нет. Напиши первым!"
          )
        );
      } else {
        for (const message of messages) {
          historyBox.append(renderMessage(message));
        }
      }

      historyBox.scrollTop = historyBox.scrollHeight;

      const conversation = state.conversations.find(
        (item) => item.userId === userId
      );

      if (conversation) {
        conversation.unread = 0;
        updateUnreadCount();
        renderConversations();
      }
    } catch (error) {
      if (requestId !== state.historyRequest) return;

      historyBox.replaceChildren(
        createElement(
          "p",
          "messages-error",
          escapeError(error, "Не удалось загрузить сообщения.")
        )
      );
    } finally {
      state.loadingMessages = false;
    }
  }

  async function uploadMedia(file) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime"
    ];

    if (!allowedTypes.includes(file.type)) {
      throw new Error(
        "Поддерживаются JPG, PNG, WEBP, GIF, MP4, WEBM и MOV."
      );
    }

    const isImage = file.type.startsWith("image/");
    const maxSize = isImage ? 15 * 1024 * 1024 : 100 * 1024 * 1024;

    if (file.size <= 0 || file.size > maxSize) {
      throw new Error(
        isImage
          ? "Максимальный размер фото — 15 МБ."
          : "Максимальный размер видео — 100 МБ."
      );
    }

    const prepared = await apiRequest("/api/chats/media-upload", {
      method: "POST",
      body: JSON.stringify({
        mimeType: file.type,
        size: file.size
      })
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

    if (error) {
      throw new Error(
        error.message || "Не удалось загрузить файл."
      );
    }

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

      if (file) {
        media = await uploadMedia(file);
      }

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
      alert(escapeError(error, "Не удалось отправить сообщение."));
    } finally {
      state.sending = false;
      sendButton.disabled = false;
      sendButton.textContent = originalLabel;
    }
  }

  button.addEventListener("click", showModal);
  closeButton.addEventListener("click", hideModal);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      hideModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      hideModal();
    }
  });

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchUsers(searchInput.value);
  });

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();

    if (query.length < 2) {
      state.searchRequest++;
      renderConversations();
      setStatus("");
    }
  });

  composeForm.addEventListener("submit", sendMessage);

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
      currentUserBox.textContent = "Выбери переписку";
    }
  });

  loadSession().then((user) => {
    if (user) {
      button.hidden = false;
      loadConversations();
    }
  });
})();
