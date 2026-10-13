"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const {
  AccessToken,
  RoomServiceClient
} = require("livekit-server-sdk");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const HOST_SESSION_SECRET = process.env.HOST_SESSION_SECRET || "";
const HOST_PROFILE_ID = process.env.HOST_PROFILE_ID || "";

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

/* Подключение к LiveKit для подсчёта зрителей */

const livekitHttpUrl = LIVEKIT_URL
  .replace(/^wss:/i, "https:")
  .replace(/^ws:/i, "http:");

const livekitRooms = new RoomServiceClient(
  livekitHttpUrl,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

const GUEST_COOKIE = "yfetish_live_guest";
const HOST_COOKIE = "yfetish_live_host";

const HOST_TIMEOUT_MS = 60 * 1000;
const OLD_STREAM_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const HOST_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

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

  return res.status(500).json({
    error: message
  });
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

function setCookie(res, name, value, maxAge) {
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearCookie(res, name) {
  res.append(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

/* Кошелёк гостя */

function setGuestCookie(res, value) {
  setCookie(res, GUEST_COOKIE, value, 604800);
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

/* Защищённая сессия ведущего по общему паролю */

function hostSignature(expires) {
  return crypto
    .createHmac("sha256", HOST_SESSION_SECRET)
    .update(`${HOST_PROFILE_ID}.${expires}`)
    .digest("hex");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function getHostSession(req) {
  if (!HOST_SESSION_SECRET || !HOST_PROFILE_ID) {
    return null;
  }

  const value = getCookie(req, HOST_COOKIE);

  if (!value) return null;

  const parts = value.split(".");

  if (parts.length !== 2) return null;

  const expires = parts[0];
  const signature = parts[1];

  if (!/^\d+$/.test(expires)) return null;
  if (Number(expires) <= Date.now()) return null;

  if (!safeEqual(signature, hostSignature(expires))) {
    return null;
  }

  return {
    hostId: HOST_PROFILE_ID,
    expires: Number(expires)
  };
}

function createHostSession(res) {
  const expires = String(Date.now() + HOST_SESSION_MS);
  const signature = hostSignature(expires);

  setCookie(
    res,
    HOST_COOKIE,
    `${expires}.${signature}`,
    Math.floor(HOST_SESSION_MS / 1000)
  );
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

/*
 * Доступ ведущего:
 * 1. Через защищённую сессию общего пароля.
 * 2. Через существующий аккаунт Supabase.
 */

async function requireHostAccess(req, res, next) {
  try {
    const session = getHostSession(req);

    if (session) {
      req.hostId = session.hostId;
      req.sharedHost = true;
      return next();
    }

    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Войди как ведущий, чтобы продолжить."
      });
    }

    req.user = user;
    req.hostId = user.id;
    req.sharedHost = false;

    next();
  } catch (error) {
    sendError(res, error, "Не удалось проверить доступ ведущего");
  }
}

/* Проверка профиля ведущего */

async function ensureHostProfile(user) {
  const { data: profile, error: checkError } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (checkError) throw checkError;

  if (profile) return;

  const emailName = user.email
    ? user.email.split("@")[0]
    : "";

  const username = cleanText(
    user.user_metadata?.username ||
    user.user_metadata?.nickname ||
    emailName ||
    `user_${user.id.replace(/-/g, "").slice(0, 12)}`,
    50
  );

  const { error: insertError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: user.id,
        username
      },
      {
        onConflict: "id",
        ignoreDuplicates: true
      }
    );

  if (insertError) throw insertError;

  console.log("Профиль ведущего проверен:", user.id);
}

async function ensureSharedHostProfile() {
  if (!HOST_PROFILE_ID) {
    throw new Error(
      "В Render не задан HOST_PROFILE_ID — укажи существующий ID из profiles"
    );
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", HOST_PROFILE_ID)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw new Error(
      "HOST_PROFILE_ID не найден в profiles. Укажи ID существующего профиля"
    );
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

async function getHostNickname(hostId) {
  const { data: userProfile } = await supabase
    .from("user_profiles")
    .select("nickname")
    .eq("id", hostId)
    .maybeSingle();

  if (userProfile?.nickname) {
    return userProfile.nickname;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", hostId)
    .maybeSingle();

  return profile?.username || "Ведущий";
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
  "coins.html",
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

    const { data: existing, error: readError } = await supabase
      .from("user_wallets")
      .select("balance")
      .eq("user_id", userId)
      .single();

    if (readError) throw readError;

    res.json({
      balance: Number(existing.balance || 0)
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить баланс монет");
  }
});

/* Статус авторизации ведущего */

app.get("/api/host/status", async (req, res) => {
  try {
    const session = getHostSession(req);

    if (session) {
      return res.json({
        authenticated: true,
        sharedHost: true,
        userId: session.hostId,
        nickname: await getHostNickname(session.hostId)
      });
    }

    const user = await getUser(req);

    if (!user) {
      return res.json({
        authenticated: false,
        sharedHost: false
      });
    }

    res.json({
      authenticated: true,
      sharedHost: false,
      userId: user.id,
      nickname: await getNickname(user)
    });
  } catch (error) {
    sendError(res, error, "Не удалось проверить статус ведущего");
  }
});

/* Вход ведущего по общему паролю */

app.post("/api/host/login", async (req, res) => {
  try {
    if (!HOST_PASSWORD || !HOST_SESSION_SECRET || !HOST_PROFILE_ID) {
      return res.status(503).json({
        error: "В Render должны быть заданы HOST_PASSWORD, HOST_SESSION_SECRET и HOST_PROFILE_ID."
      });
    }

    const password = typeof req.body?.password === "string"
      ? req.body.password
      : "";

    if (!safeEqual(password, HOST_PASSWORD)) {
      return res.status(401).json({
        error: "Неверный пароль"
      });
    }

    await ensureSharedHostProfile();

    createHostSession(res);

    res.json({
      success: true,
      authenticated: true,
      sharedHost: true,
      userId: HOST_PROFILE_ID,
      nickname: await getHostNickname(HOST_PROFILE_ID)
    });
  } catch (error) {
    sendError(res, error, "Не удалось выполнить вход ведущего");
  }
});

/* Выход ведущего */

app.post("/api/host/logout", (req, res) => {
  clearCookie(res, HOST_COOKIE);

  res.json({ success: true });
});

/* Активность эфира: только его владелец */

app.post("/api/streams/heartbeat", requireHostAccess, async (req, res) => {
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

    if (stream.host_id !== req.hostId) {
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

/* Список эфиров с реальным количеством зрителей */

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

    const resultStreams = await Promise.all(
      streams.map(async (stream) => {
        let viewerCount = null;

        try {
          const participants =
            await livekitRooms.listParticipants(stream.room_name);

          viewerCount = (participants || []).filter(
            participant =>
              typeof participant.identity === "string" &&
              participant.identity.startsWith("viewer-")
          ).length;
        } catch (error) {
          console.error(
            `Не удалось получить зрителей комнаты ${stream.room_name}:`,
            error.message
          );
        }

        return {
          ...stream,
          nickname: names.get(stream.host_id) || "Ведущий",
          viewer_count: viewerCount
        };
      })
    );

    res.json(resultStreams);
  } catch (error) {
    sendError(res, error, "Не удалось загрузить эфиры");
  }
});

/* Запуск эфира */

app.post("/api/streams/start", requireHostAccess, async (req, res) => {
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

    if (req.sharedHost) {
      await ensureSharedHostProfile();
    } else {
      await ensureHostProfile(req.user);
    }

    await cleanupOldStreams();

    const { data: existing, error: checkError } = await supabase
      .from("live_streams")
      .select("id, host_id")
      .eq("status", "live")
      .eq("host_id", req.hostId)
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
        host_id: req.hostId,
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

app.post("/api/streams/stop", requireHostAccess, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    const stopped = await endStream(roomName, req.hostId);

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
    const session = getHostSession(req);

    const authenticatedHostId = session
      ? session.hostId
      : user?.id;

    const isHost = Boolean(
      authenticatedHostId &&
      stream.host_id === authenticatedHostId
    );

    const identity = isHost
      ? `host-${authenticatedHostId}`
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

/* Кошелёк гостя */

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
