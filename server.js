"use strict";

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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Не заданы SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY");
}

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Не заданы настройки LiveKit");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const GUEST_COOKIE = "yfetish_live_guest";

const GUEST_SESSION_SECRET =
  process.env.GUEST_SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

const HOST_TIMEOUT_MS = 60 * 1000;
const OLD_STREAM_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const hostActivity = new Map();

function cleanText(value, max = 300) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function validRoomName(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function sendError(res, error, message = "Ошибка сервера") {
  console.error(message, error);
  return res.status(500).json({ error: message });
}

function getCookie(req, name) {
  for (const item of (req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");

    if (index < 0) continue;

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

function setGuestCookie(res, value) {
  res.append(
    "Set-Cookie",
    `${GUEST_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
  );
}

function guestId(req, res) {
  const existing = getCookie(req, GUEST_COOKIE);

  if (existing && /^[a-f0-9-]{36}$/i.test(existing)) {
    return existing;
  }

  const id = crypto.randomUUID();
  setGuestCookie(res, id);

  return id;
}

/* Проверка аккаунта через Supabase Auth */

async function getUser(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) return null;

  const { data, error } = await supabase.auth.getUser(match[1]);

  if (error || !data?.user) return null;

  return data.user;
}

async function requireUser(req, res, next) {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Войди в свой аккаунт, чтобы продолжить."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    sendError(res, error, "Не удалось проверить аккаунт");
  }
}

async function getNickname(user) {
  const { data } = await supabase
    .from("user_profiles")
    .select("nickname")
    .eq("id", user.id)
    .maybeSingle();

  return data?.nickname ||
    cleanText(user.user_metadata?.nickname, 24) ||
    "Пользователь";
}

async function getLiveStream(roomName) {
  const { data, error } = await supabase
    .from("live_streams")
    .select("*")
    .eq("room_name", roomName)
    .eq("status", "live")
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function endStream(roomName, hostId) {
  let query = supabase
    .from("live_streams")
    .update({
      status: "ended",
      ended_at: new Date().toISOString()
    })
    .eq("room_name", roomName)
    .eq("status", "live");

  if (hostId) {
    query = query.eq("host_id", hostId);
  }

  const { data, error } = await query.select("id");

  if (error) throw error;

  hostActivity.delete(roomName);

  return Boolean(data?.length);
}

/* Очистка зависших эфиров */

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
      const lastActivity = hostActivity.get(stream.room_name);
      const startedAt = Date.parse(stream.started_at || "");

      if (
        lastActivity &&
        now - lastActivity > HOST_TIMEOUT_MS
      ) {
        await endStream(stream.room_name);
      } else if (
        !lastActivity &&
        Number.isFinite(startedAt) &&
        now - startedAt > OLD_STREAM_TIMEOUT_MS
      ) {
        await endStream(stream.room_name);
      }
    }
  } catch (error) {
    console.error("Очистка эфиров:", error);
  } finally {
    cleanupRunning = false;
  }
}

setInterval(cleanupOldStreams, 15000);
cleanupOldStreams();

/* Страницы */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

for (const page of [
  "index.html",
  "live.html",
  "host.html",
  "login.html",
  "app.js",
  "host.js",
  "style.css"
]) {
  const route = page === "index.html" ? "/" : `/${page}`;

  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, page));
  });
}

/* Баланс монет зарегистрированного пользователя */

app.get("/api/account/wallet", requireUser, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from("user_wallets")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      return res.json({
        balance: Number(data.balance || 0)
      });
    }

    const { data: created, error: createError } = await supabase
      .from("user_wallets")
      .upsert(
        {
          user_id: userId,
          balance: 0
        },
        {
          onConflict: "user_id",
          ignoreDuplicates: true
        }
      )
      .select("balance")
      .maybeSingle();

    if (createError) throw createError;

    if (created) {
      return res.json({
        balance: Number(created.balance || 0)
      });
    }

    /* Если запись создал параллельный запрос, читаем её повторно */

    const { data: existing, error: readError } = await supabase
      .from("user_wallets")
      .select("balance")
      .eq("user_id", userId)
      .single();

    if (readError) throw readError;

    return res.json({
      balance: Number(existing.balance || 0)
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить баланс монет");
  }
});

/* Статус авторизации */

app.get("/api/host/status", requireUser, async (req, res) => {
  try {
    res.json({
      authenticated: true,
      userId: req.user.id,
      nickname: await getNickname(req.user)
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить профиль");
  }
});

/* Совместимость со старой формой входа */

app.post("/api/host/login", (req, res) => {
  res.status(410).json({
    error: "Общий пароль отключён. Войди через свой аккаунт."
  });
});

app.post("/api/host/logout", (req, res) => {
  res.json({ success: true });
});

/* Активность эфира: только его владелец */

app.post("/api/streams/heartbeat", requireUser, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const { data: stream, error } = await supabase
      .from("live_streams")
      .select("id, host_id")
      .eq("room_name", roomName)
      .eq("status", "live")
      .maybeSingle();

    if (error) throw error;

    if (!stream) {
      hostActivity.delete(roomName);

      return res.status(404).json({
        error: "Эфир уже завершён"
      });
    }

    if (stream.host_id !== req.user.id) {
      return res.status(403).json({
        error: "Это не твой эфир"
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

    if (error) throw error;

    const streams = data || [];
    const ids = [
      ...new Set(streams.map(s => s.host_id).filter(Boolean))
    ];

    let profiles = [];

    if (ids.length) {
      const result = await supabase
        .from("user_profiles")
        .select("id, nickname")
        .in("id", ids);

      if (!result.error) {
        profiles = result.data || [];
      }
    }

    const names = new Map(
      profiles.map(p => [p.id, p.nickname])
    );

    res.json(streams.map(stream => ({
      ...stream,
      nickname: names.get(stream.host_id) || "Ведущий"
    })));
  } catch (error) {
    sendError(res, error, "Не удалось загрузить эфиры");
  }
});

/* Запуск эфира */

app.post("/api/streams/start", requireUser, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 150) || "Прямой эфир";
    const roomName = cleanText(req.body?.roomName, 100);

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

    const { data: existing, error: checkError } = await supabase
      .from("live_streams")
      .select("id, host_id")
      .eq("status", "live")
      .eq("host_id", req.user.id)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existing) {
      return res.status(409).json({
        error: "У тебя уже есть активный эфир."
      });
    }

    const { data: roomExisting, error: roomError } = await supabase
      .from("live_streams")
      .select("id")
      .eq("room_name", roomName)
      .eq("status", "live")
      .maybeSingle();

    if (roomError) throw roomError;

    if (roomExisting) {
      return res.status(409).json({
        error: "Имя комнаты уже используется. Попробуй ещё раз."
      });
    }

    const { data, error } = await supabase
      .from("live_streams")
      .insert({
        host_id: req.user.id,
        title,
        room_name: roomName,
        country,
        status: "live",
        started_at: new Date().toISOString(),
        ended_at: null
      })
      .select()
      .single();

    if (error) throw error;

    hostActivity.set(roomName, Date.now());

    res.json({
      success: true,
      stream: data,
      roomName
    });
  } catch (error) {
    sendError(res, error, "Не удалось создать эфир");
  }
});

/* Завершение эфира */

app.post("/api/streams/stop", requireUser, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const stopped = await endStream(roomName, req.user.id);

    res.json({
      success: true,
      stopped
    });
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

    const user = await getUser(req);
    const isHost = Boolean(user && stream.host_id === user.id);

    const identity = isHost
      ? `host-${user.id}`
      : `viewer-${crypto.randomUUID()}`;

    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity,
        ttl: "2h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: isHost,
      canSubscribe: true,
      canPublishData: true
    });

    res.json({
      token: await token.toJwt(),
      url: LIVEKIT_URL,
      serverUrl: LIVEKIT_URL,
      isHost,
      roomName,
      title: stream.title
    });
  } catch (error) {
    sendError(res, error, "Не удалось получить токен LiveKit");
  }
});

/* Чат: загрузка сообщений */

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

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить чат");
  }
});

/* Чат: отправка сообщений */

app.post("/api/chat", async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);
    const message = cleanText(req.body?.message, 500);

    if (!validRoomName(roomName) || !message) {
      return res.status(400).json({
        error: "Укажи комнату и сообщение"
      });
    }

    if (!await getLiveStream(roomName)) {
      return res.status(404).json({
        error: "Эфир завершён"
      });
    }

    const user = await getUser(req);

    const participantName = user
      ? await getNickname(user)
      : cleanText(
          req.body?.participantName || req.body?.name,
          40
        ) || "Гость";

    const { data, error } = await supabase
      .from("live_messages")
      .insert({
        room_name: roomName,
        participant_name: participantName,
        message
      })
      .select()
      .single();

    if (error) throw error;

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

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить подарки");
  }
});

/* Кошелёк гостя — оставлен без изменений */

app.get("/api/wallet", async (req, res) => {
  try {
    const id = guestId(req, res);

    const { data, error } = await supabase
      .from("live_wallets")
      .select("*")
      .eq("guest_id", id)
      .maybeSingle();

    if (error) throw error;

    res.json({
      guestId: id,
      balance: Number(data?.balance || 0)
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить кошелёк");
  }
});

/* Отправка подарка — оставлена без изменений */

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

/* Неизвестные маршруты */

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API-маршрут не найден"
  });
});

app.use((req, res) => {
  res.status(404).send("Страница не найдена");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
