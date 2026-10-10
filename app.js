
const API = "/api";

const giftList = document.getElementById("giftList");
const giftMessage = document.getElementById("giftMessage");
const balanceElement = document.getElementById("coinBalance");
const streamTitle = document.getElementById("streamTitle");
const hostName = document.getElementById("hostName");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");

const params = new URLSearchParams(window.location.search);
const streamId = params.get("id");

let gifts = [];
let balance = 0;

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || "Ошибка сервера");
  }

  return result;
}

function showMessage(message) {
  giftMessage.textContent = message;
}

function renderGifts() {
  giftList.replaceChildren();

  if (!gifts.length) {
    giftList.textContent = "Подарки пока недоступны.";
    return;
  }

  gifts.forEach((gift) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gift-item";

    const emoji = document.createElement("span");
    emoji.className = "emoji";
    emoji.textContent = gift.emoji;

    const name = document.createElement("span");
    name.textContent = gift.name;

    const price = document.createElement("span");
    price.textContent = `${gift.price} монет`;

    button.append(emoji, name, document.createElement("br"), price);

    button.addEventListener("click", () => {
      showMessage(
        "Отправка подарков подключится после настройки защищённого API."
      );
    });

    giftList.appendChild(button);
  });
}

async function loadGifts() {
  try {
    gifts = await apiRequest("/gifts");
    renderGifts();
  } catch (error) {
    giftList.textContent = "Не удалось загрузить подарки.";
    console.error(error);
  }
}

async function loadBalance() {
  // Баланс появится после подключения безопасного кошелька.
  balance = 0;
  balanceElement.textContent = String(balance);
}

async function loadStream() {
  if (!streamId) {
    streamTitle.textContent = "Эфир не выбран";
    hostName.textContent = "Вернись в каталог и выбери эфир.";
    videoPlaceholder.textContent = "Нет идентификатора эфира";
    return;
  }

  try {
    const streams = await apiRequest("/streams");
    const stream = streams.find((item) => item.id === streamId);

    if (!stream) {
      streamTitle.textContent = "Эфир не найден";
      hostName.textContent = "Возможно, трансляция завершена.";
      return;
    }

    streamTitle.textContent = stream.title;
    hostName.textContent =
      stream.profiles?.username || "Ведущий";

    videoPlaceholder.textContent =
      "Эфир найден. Подключение видео настроим через LiveKit.";
  } catch (error) {
    streamTitle.textContent = "Не удалось загрузить эфир";
    console.error(error);
  }
}

chatForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!chatInput.value.trim()) return;

  showMessage(
    "Чат ещё не подключён. Добавим его через сервер, чтобы сообщения видели другие зрители."
  );

  chatInput.value = "";
});

async function init() {
  await Promise.all([
    loadGifts(),
    loadBalance(),
    loadStream()
  ]);
}

init();
