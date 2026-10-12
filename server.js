const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const HOST_PASSWORD = process.env.HOST_PASSWORD;

const GUEST_SESSION_SECRET =
  process.env.GUEST_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Не заданы SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY");
}

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !HOST_PASSWORD) {
  throw new Error("Не заданы настройки LiveKit или HOST_PASSWORD");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const HOST_COOKIE = "yfetish_live_host";
const GUEST_COOKIE = "yfetish_live_guest";

const HOST_TIMEOUT_MS = 60 * 1000;
const OLD_STREAM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const hostActivity = new Map();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function sign(value) {
  return crypto
    .createHmac("sha256", GUEST_SESSION_SECRET)
    .update(value)
    .digest("hex");
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");

  for (const item of cookies) {
    const index = item.indexOf("=");

    if (index === -1) continue;

    if (item.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(item.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }

  return null;
}

function isHost(req) {
  const value = getCookie(req, HOST_COOKIE);

  if (!value) return false;

  const parts = value.split(".");

  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  return payload === "host" && safeEqual(sign(payload), signature);
}

function requireHost(req, res, next) {
  if (!isHost(req)) {
    return res.status(401).json({
      error: "Требуется авторизация ведущего"
    });
  }

  next();
}

function validRoomName(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

function cleanText(value, maxLength = 300) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function guestId(req, res) {
  const existing = getCookie(req, GUEST_COOKIE);

  if (existing && /^[a-f0-9-]{36}$/i.test(existing)) {
    return existing;
  }

  const id = crypto.randomUUID();

  res.cookie(GUEST_COOKIE, id, COOKIE_OPTIONS);

  return id;
}

async function getLiveStream(roomName) {
  const { data, error } = await supabase
    .from("live_streams")
    .select("*")
    .eq("room_name", roomName)
    .eq("status", "live")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  return data;
}

function sendError(res, error, message = "Ошибка сервера") {
  console.error(message, error);

  return res.status(500).json({
    error: message
  });
}

/* Завершение эфира */

async function endStream(roomName, reason = "automatic") {
  const { data, error } = await supabase
    .from("live_streams")
    .update({
      status: "ended",
      ended_at: new Date().toISOString()
    })
    .eq("room_name", roomName)
    .eq("status", "live")
    .select("id");

  if (error) throw error;

  hostActivity.delete(roomName);

  if (data && data.length) {
    console.log(`Эфир ${roomName} завершён: ${reason}`);
  }

  return Boolean(data && data.length);
}

/* Автоматическая очистка зависших эфиров */

let cleanupRunning = false;

async function cleanupOldStreams() {
  if (cleanupRunning) return;

  cleanupRunning = true;

  try {
    const { data: streams, error } = await supabase
      .from("live_streams")
      .select("room_name, started_at")
      .eq("status", "live");

    if (error) throw error;

    const now = Date.now();

    for (const stream of streams || []) {
      const roomName = stream.room_name;
      const lastActivity = hostActivity.get(roomName);

      if (
        lastActivity &&
        now - lastActivity > HOST_TIMEOUT_MS
      ) {
        await endStream(roomName, "host timeout");
        continue;
      }

      const startedAt = Date.parse(stream.started_at || "");

      if (
        !lastActivity &&
        Number.isFinite(startedAt) &&
        now - startedAt > OLD_STREAM_TIMEOUT_MS
      ) {
        await endStream(roomName, "old stream cleanup");
      }
    }
  } catch (error) {
    console.error("Ошибка автоматической очистки эфиров:", error);
  } finally {
    cleanupRunning = false;
  }
}

setInterval(cleanupOldStreams, 15000);
cleanupOldStreams();

/* Проверка сервера */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* Страницы */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/live.html", (req, res) => {
  res.sendFile(path.join(__dirname, "live.html"));
});

app.get("/host.html", (req, res) => {
  res.sendFile(path.join(__dirname, "host.html"));
});

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/host.js", (req, res) => {
  res.sendFile(path.join(__dirname, "host.js"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

/* Авторизация ведущего */

app.get("/api/host/status", (req, res) => {
  res.json({ authenticated: isHost(req) });
});

app.post("/api/host/login", (req, res) => {
  if (!safeEqual(req.body?.password, HOST_PASSWORD)) {
    return res.status(401).json({ error: "Неверный пароль" });
  }

  const payload = "host";

  res.cookie(
    HOST_COOKIE,
    `${payload}.${sign(payload)}`,
    COOKIE_OPTIONS
  );

  res.json({ success: true });
});

app.post("/api/host/logout", (req, res) => {
  res.clearCookie(HOST_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });

  res.json({ success: true });
});

/* Сигнал активности ведущего */

app.post("/api/streams/heartbeat", requireHost, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const stream = await getLiveStream(roomName);

    if (!stream) {
      hostActivity.delete(roomName);

      return res.status(404).json({
        error: "Эфир уже завершён"
      });
    }

    hostActivity.set(roomName, Date.now());

    res.json({ success: true });
  } catch (error) {
    sendError(res, error, "Не удалось проверить активность эфира");
  }
});

/* Список эфиров */

app.get("/api/streams", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("live_streams")
      .select("*")
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) {
      return sendError(res, error, "Не удалось загрузить эфиры");
    }

    res.json(data || []);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить эфиры");
  }
});

/* Запуск эфира */

app.post("/api/streams/start", requireHost, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 150) || "Прямой эфир";
    const roomName = cleanText(req.body?.roomName, 100);

    // СТРАНА ЭФИРА: разрешаем только варианты из списка.
    const allowedCountries = [
      "Украина",
      "Россия",
      "Польша",
      "Германия",
      "Другие"
    ];

    const requestedCountry = cleanText(req.body?.country, 50);
    const country = allowedCountries.includes(requestedCountry)
      ? requestedCountry
      : "Украина";

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    await cleanupOldStreams();

    const { data: existingLive, error: checkError } = await supabase
      .from("live_streams")
      .select("id, room_name")
      .eq("status", "live")
      .limit(1)
      .maybeSingle();

    if (checkError) {
      console.error("Ошибка проверки эфира:", checkError);

      return res.status(500).json({
        error: "Не удалось проверить активные эфиры"
      });
    }

    if (existingLive) {
      return res.status(409).json({
        error: "Уже есть активный эфир",
        roomName: existingLive.room_name
      });
    }

    const { data, error } = await supabase
      .from("live_streams")
      .upsert(
        {
          title,
          room_name: roomName,
          country, // СТРАНА ЭФИРА: сохраняем в Supabase.
          status: "live",
          started_at: new Date().toISOString(),
          ended_at: null
        },
        {
          onConflict: "room_name"
        }
      )
      .select()
      .single();

    if (error) {
      console.error("Не удалось создать эфир:", error);

      return res.status(500).json({
        error: "Не удалось создать эфир",
        details: error.message
      });
    }

    hostActivity.set(roomName, Date.now());

    return res.json({
      success: true,
      stream: data,
      roomName
    });
  } catch (error) {
    console.error("Не удалось запустить эфир:", error);

    return res.status(500).json({
      error: "Не удалось запустить эфир",
      details: error.message
    });
  }
});

/* Ручное завершение эфира */

app.post("/api/streams/stop", requireHost, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const stopped = await endStream(roomName, "manual");

    res.json({ success: true, stopped });
  } catch (error) {
    sendError(res, error, "Не удалось завершить эфир");
  }
});

/* Токен LiveKit */

app.get("/api/livekit/token", async (req, res) => {
  try {
    const roomName = cleanText(req.query.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const stream = await getLiveStream(roomName);

    if (!stream) {
      return res.status(404).json({
        error: "Эфир не найден или уже завершён"
      });
    }

    const host = isHost(req);

    const identity = host
      ? `host-${crypto.randomUUID()}`
      : `viewer-${crypto.randomUUID()}`;

    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      { identity, ttl: "2h" }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: host,
      canSubscribe: true,
      canPublishData: true
    });

    const jwt = await token.toJwt();

    res.json({
      token: jwt,
      url: LIVEKIT_URL,
      serverUrl: LIVEKIT_URL,
      isHost: host,
      roomName,
      title: stream.title
    });
  } catch (error) {
    sendError(res, error, "Не удалось получить токен LiveKit");
  }
});

/* Загрузка чата */

app.get("/api/chat", async (req, res) => {
  try {
    const roomName = cleanText(req.query.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const { data, error } = await supabase
      .from("live_messages")
      .select("*")
      .eq("room_name", roomName)
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      return sendError(res, error, "Не удалось загрузить чат");
    }

    res.json(data || []);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить чат");
  }
});

/* Отправка сообщения */

app.post("/api/chat", async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);
    const message = cleanText(req.body?.message, 500);

    const participantName =
      cleanText(req.body?.participantName || req.body?.name, 40) ||
      "Гость";

    if (!validRoomName(roomName) || !message) {
      return res.status(400).json({
        error: "Укажите комнату и сообщение"
      });
    }

    if (!await getLiveStream(roomName)) {
      return res.status(404).json({
        error: "Эфир завершён"
      });
    }

    const { data, error } = await supabase
      .from("live_messages")
      .insert({
        room_name: roomName,
        participant_name: participantName,
        message
      })
      .select()
      .single();

    if (error) {
      return sendError(res, error, "Не удалось отправить сообщение");
    }

    res.json({
      success: true,
      message: data
    });
  } catch (error) {
    sendError(res, error, "Не удалось отправить сообщение");
  }
});

/* Подарки */

app.get("/api/gifts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("gifts")
      .select("*")
      .eq("active", true)
      .order("price", { ascending: true });

    if (error) {
      return sendError(res, error, "Не удалось загрузить подарки");
    }

    res.json(data || []);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить подарки");
  }
});

/* Баланс кошелька */

app.get("/api/wallet", async (req, res) => {
  try {
    const id = guestId(req, res);

    const { data, error } = await supabase
      .from("live_wallets")
      .select("*")
      .eq("guest_id", id)
      .maybeSingle();

    if (error) {
      return sendError(res, error, "Не удалось загрузить кошелёк");
    }

    res.json({
      guestId: id,
      balance: Number(data?.balance || 0)
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить кошелёк");
  }
});

/* Отправка подарка */

app.post("/api/gifts/send", async (req, res) => {
  try {
    const id = guestId(req, res);
    const roomName = cleanText(req.body?.roomName, 100);
    const giftId = Number(req.body?.giftId);

    if (
      !validRoomName(roomName) ||
      !Number.isSafeInteger(giftId) ||
      giftId <= 0
    ) {
      return res.status(400).json({
        error: "Неверные данные подарка"
      });
    }

    if (!await getLiveStream(roomName)) {
      return res.status(404).json({
        error: "Эфир завершён"
      });
    }

    const { data, error } = await supabase.rpc("send_live_gift", {
      p_guest_id: id,
      p_room_name: roomName,
      p_gift_id: giftId
    });

    if (error) {
      console.error("Ошибка отправки подарка:", error);

      return res.status(400).json({
        error: error.message || "Не удалось отправить подарок"
      });
    }

    res.json({
      success: true,
      result: data
    });
  } catch (error) {
    sendError(res, error, "Не удалось отправить подарок");
  }
});

/* Неизвестные API-маршруты */

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API-маршрут не найден"
  });
});

/* Неизвестные страницы */

app.use((req, res) => {
  res.status(404).send("Страница не найдена");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
