require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  HOST_PASSWORD,
  GUEST_SESSION_SECRET
} = process.env;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

const COOKIE_HOST = "yfetish_live_host";
const COOKIE_GUEST = "yfetish_live_guest";

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function sign(value, secret) {
  return crypto
    .createHmac("sha256", secret || "missing-secret")
    .update(value)
    .digest("hex");
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function setCookie(res, name, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`
  );
}

function clearCookie(res, name) {
  res.setHeader(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`
  );
}

function createSession(secret) {
  const id = crypto.randomUUID();
  return `${id}.${sign(id, secret)}`;
}

function validSession(req, name, secret) {
  const value = parseCookies(req)[name];
  if (!value) return false;

  const index = value.lastIndexOf(".");
  if (index < 1) return false;

  const id = value.slice(0, index);
  const signature = value.slice(index + 1);

  return safeEqual(signature, sign(id, secret));
}

function isHost(req) {
  return Boolean(HOST_PASSWORD) &&
    validSession(req, COOKIE_HOST, HOST_PASSWORD);
}

function getGuestId(req, res) {
  const secret = GUEST_SESSION_SECRET || HOST_PASSWORD;
  if (!secret) return null;

  const value = parseCookies(req)[COOKIE_GUEST];

  if (value) {
    const index = value.lastIndexOf(".");
    if (index > 0) {
      const id = value.slice(0, index);
      const signature = value.slice(index + 1);

      if (safeEqual(signature, sign(id, secret))) {
        return id;
      }
    }
  }

  const session = createSession(secret);
  setCookie(res, COOKIE_GUEST, session, 60 * 60 * 24 * 365);
  return session.split(".")[0];
}

function requireDatabase(res) {
  if (!supabase) {
    res.status(500).json({
      error: "Не настроены SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY"
    });
    return false;
  }
  return true;
}

function getRoomName(req) {
  return String(
    req.query.roomName ||
    req.query.room_name ||
    req.body?.roomName ||
    req.body?.room_name ||
    req.body?.room ||
    ""
  ).trim();
}

async function getActiveStream(roomName) {
  let query = supabase
    .from("live_streams")
    .select("*")
    .eq("status", "live");

  if (roomName) query = query.eq("room_name", roomName);

  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

// Проверка сервера
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// HTML и скрипты находятся в корне репозитория
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/live.html", (req, res) => {
  res.sendFile(path.join(ROOT, "live.html"));
});

app.get("/host.html", (req, res) => {
  res.sendFile(path.join(ROOT, "host.html"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(ROOT, "app.js"));
});

app.get("/host.js", (req, res) => {
  res.sendFile(path.join(ROOT, "host.js"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(ROOT, "style.css"));
});

// Если у проекта есть дополнительные изображения или стили,
// добавь для них отдельные маршруты, не открывая весь корень сервера.

// Авторизация ведущего
app.get("/api/host/status", (req, res) => {
  res.json({ authenticated: isHost(req) });
});

app.post("/api/host/login", (req, res) => {
  if (!HOST_PASSWORD) {
    return res.status(500).json({
      error: "На Render не задан HOST_PASSWORD"
    });
  }

  const password = String(req.body?.password || "");

  if (!safeEqual(password, HOST_PASSWORD)) {
    return res.status(401).json({
      error: "Неверный пароль"
    });
  }

  setCookie(
    res,
    COOKIE_HOST,
    createSession(HOST_PASSWORD),
    60 * 60 * 24
  );

  res.json({ success: true });
});

app.post("/api/host/logout", (req, res) => {
  clearCookie(res, COOKIE_HOST);
  res.json({ success: true });
});

// Список активных эфиров
app.get("/api/streams", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const { data, error } = await supabase
      .from("live_streams")
      .select("*")
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("GET /api/streams:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Запуск эфира
app.post("/api/streams/start", async (req, res) => {
  if (!isHost(req)) {
    return res.status(401).json({
      error: "Сначала войдите как ведущий"
    });
  }

  if (!requireDatabase(res)) return;

  const title = String(req.body?.title || "").trim().slice(0, 150);
  const roomName =
    String(req.body?.roomName || req.body?.room_name || "").trim() ||
    `yfetish-${crypto.randomUUID()}`;

  if (!title) {
    return res.status(400).json({
      error: "Введите название эфира"
    });
  }

  try {
    const existing = await getActiveStream("");

    if (existing) {
      return res.status(409).json({
        error: "Уже идёт эфир",
        stream: existing
      });
    }

    const { data, error } = await supabase
      .from("live_streams")
      .insert({
        title,
        room_name: roomName,
        status: "live",
        started_at: new Date().toISOString(),
        ended_at: null
      })
      .select("*")
      .single();

    if (error) throw error;

    res.json({ success: true, stream: data });
  } catch (error) {
    console.error("POST /api/streams/start:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Остановка эфира
app.post("/api/streams/stop", async (req, res) => {
  if (!isHost(req)) {
    return res.status(401).json({
      error: "Сначала войдите как ведущий"
    });
  }

  if (!requireDatabase(res)) return;

  const roomName = getRoomName(req);

  try {
    let query = supabase
      .from("live_streams")
      .update({
        status: "ended",
        ended_at: new Date().toISOString()
      })
      .eq("status", "live");

    if (roomName) query = query.eq("room_name", roomName);

    const { data, error } = await query.select("*");
    if (error) throw error;

    res.json({ success: true, streams: data || [] });
  } catch (error) {
    console.error("POST /api/streams/stop:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Токен для подключения к LiveKit
app.get("/api/livekit/token", async (req, res) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({
      error: "Не настроены переменные LiveKit в Render"
    });
  }

  if (!requireDatabase(res)) return;

  const roomName = getRoomName(req);
  if (!roomName) {
    return res.status(400).json({
      error: "Не указана комната эфира"
    });
  }

  try {
    const stream = await getActiveStream(roomName);

    if (!stream) {
      return res.status(404).json({
        error: "Этот эфир не найден или уже завершён"
      });
    }

    const host = isHost(req);
    const identity = host
      ? `host-${crypto.randomUUID()}`
      : `guest-${crypto.randomUUID()}`;

    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity,
        name: host ? "Ведущий" : "Гость",
        ttl: "2h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: host,
      canSubscribe: true,
      canPublishData: true
    });

    res.json({
      token: await token.toJwt(),
      url: LIVEKIT_URL,
      serverUrl: LIVEKIT_URL,
      isHost: host
    });
  } catch (error) {
    console.error("GET /api/livekit/token:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Чат
app.get("/api/chat", async (req, res) => {
  if (!requireDatabase(res)) return;

  const roomName = getRoomName(req);
  if (!roomName) {
    return res.status(400).json({ error: "Не указана комната" });
  }

  try {
    const { data, error } = await supabase
      .from("live_messages")
      .select("*")
      .eq("room_name", roomName)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("GET /api/chat:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!requireDatabase(res)) return;

  const roomName = getRoomName(req);
  const message = String(req.body?.message || "").trim().slice(0, 1000);
  const participantName = String(
    req.body?.participantName || req.body?.name || "Гость"
  ).trim().slice(0, 50) || "Гость";

  if (!roomName || !message) {
    return res.status(400).json({
      error: "Укажите комнату и сообщение"
    });
  }

  try {
    const stream = await getActiveStream(roomName);
    if (!stream) {
      return res.status(404).json({ error: "Эфир завершён" });
    }

    const { data, error } = await supabase
      .from("live_messages")
      .insert({
        room_name: roomName,
        participant_name: participantName,
        message
      })
      .select("*")
      .single();

    if (error) throw error;

    res.json({ success: true, message: data });
  } catch (error) {
    console.error("POST /api/chat:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Список подарков
app.get("/api/gifts", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const { data, error } = await supabase
      .from("gifts")
      .select("id,name,emoji,price")
      .eq("active", true)
      .order("price", { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("GET /api/gifts:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Баланс зрителя
app.get("/api/wallet", async (req, res) => {
  if (!requireDatabase(res)) return;

  const guestId = getGuestId(req, res);
  if (!guestId) {
    return res.status(500).json({
      error: "Не настроен GUEST_SESSION_SECRET или HOST_PASSWORD"
    });
  }

  try {
    const { data, error } = await supabase
      .from("live_wallets")
      .upsert(
        { guest_id: guestId },
        { onConflict: "guest_id", ignoreDuplicates: true }
      )
      .select("guest_id,balance")
      .maybeSingle();

    if (error) throw error;

    if (data) return res.json(data);

    const result = await supabase
      .from("live_wallets")
      .select("guest_id,balance")
      .eq("guest_id", guestId)
      .single();

    if (result.error) throw result.error;

    res.json(result.data);
  } catch (error) {
    console.error("GET /api/wallet:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Отправка подарка и списание монет
app.post("/api/gifts/send", async (req, res) => {
  if (!requireDatabase(res)) return;

  const guestId = getGuestId(req, res);
  const roomName = getRoomName(req);
  const giftId = req.body?.giftId ?? req.body?.gift_id;

  if (!guestId || !roomName || giftId == null) {
    return res.status(400).json({
      error: "Не указаны комната или подарок"
    });
  }

  try {
    const { data, error } = await supabase.rpc("send_live_gift", {
      p_guest_id: guestId,
      p_room_name: roomName,
      p_gift_id: giftId
    });

    if (error) throw error;

    if (data?.success === false) {
      return res.status(400).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error("POST /api/gifts/send:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Обработка неизвестных API-маршрутов
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API-маршрут не найден",
    path: req.path
  });
});

// Обработка отсутствующих страниц
app.use((req, res) => {
  res.status(404).send("Not Found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
  console.log(`Root directory: ${ROOT}`);
});
