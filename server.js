
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const HOST_PASSWORD = process.env.HOST_PASSWORD;
const GUEST_SESSION_SECRET = process.env.GUEST_SESSION_SECRET;

const HOST_COOKIE = "yfetish_live_host";
const GUEST_COOKIE = "yfetish_live_guest";

function requireDatabase(res) {
  if (!supabase) {
    res.status(503).json({
      error: "Не настроены SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY"
    });
    return false;
  }
  return true;
}

function requireLiveKit(res) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    res.status(503).json({
      error: "Не настроены параметры LiveKit в Render"
    });
    return false;
  }
  return true;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index > 0) {
      cookies[part.slice(0, index).trim()] =
        part.slice(index + 1).trim();
    }
  }

  return cookies;
}

function sign(value, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("hex");
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function setSignedCookie(res, name, id, secret) {
  const signature = sign(id, secret);

  res.setHeader(
    "Set-Cookie",
    `${name}=${id}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`
  );
}

function readSignedCookie(req, name, secret) {
  if (!secret) return null;

  const value = parseCookies(req)[name];
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 2) return null;

  const [id, signature] = parts;

  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;

  if (!safeEqual(sign(id, secret), signature)) return null;

  return id;
}

function hostIdFromRequest(req) {
  return readSignedCookie(req, HOST_COOKIE, HOST_PASSWORD || "");
}

function guestIdFromRequest(req) {
  return readSignedCookie(req, GUEST_COOKIE, GUEST_SESSION_SECRET || "");
}

function requireHost(req, res) {
  if (!HOST_PASSWORD) {
    res.status(503).json({
      error: "Добавь HOST_PASSWORD в переменные Render"
    });
    return false;
  }

  if (!hostIdFromRequest(req)) {
    res.status(401).json({
      error: "Сначала войди как ведущий"
    });
    return false;
  }

  return true;
}

function validRoomName(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,80}$/.test(value)
  );
}

function publicRoot(file) {
  return path.join(__dirname, "public", file);
}

/* Основные страницы */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (req, res) => {
  res.sendFile(publicRoot("index.html"));
});

app.get("/live.html", (req, res) => {
  res.sendFile(publicRoot("live.html"));
});

app.get("/host.html", (req, res) => {
  res.sendFile(publicRoot("host.html"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(publicRoot("app.js"));
});

app.get("/host.js", (req, res) => {
  res.sendFile(publicRoot("host.js"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(publicRoot("style.css"));
});

/* Авторизация ведущего */

app.get("/api/host/status", (req, res) => {
  res.json({
    authenticated: Boolean(hostIdFromRequest(req))
  });
});

app.post("/api/host/login", (req, res) => {
  if (!HOST_PASSWORD) {
    return res.status(503).json({
      error: "Добавь HOST_PASSWORD в Render"
    });
  }

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!safeEqual(password, HOST_PASSWORD)) {
    return res.status(401).json({
      error: "Неверный пароль"
    });
  }

  const id = crypto.randomUUID();

  setSignedCookie(res, HOST_COOKIE, id, HOST_PASSWORD);

  res.json({ success: true });
});

app.post("/api/host/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${HOST_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );

  res.json({ success: true });
});

/* Список активных эфиров */

app.get("/api/streams", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const { data, error } = await supabase
      .from("live_streams")
      .select("id,title,room_name,status,started_at,ended_at")
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("Streams error:", error);
    res.status(500).json({ error: "Не удалось загрузить эфиры" });
  }
});

/* Запуск эфира */

app.post("/api/streams/start", async (req, res) => {
  if (!requireDatabase(res)) return;
  if (!requireHost(req, res)) return;

  const title =
    typeof req.body?.title === "string"
      ? req.body.title.trim().slice(0, 120)
      : "";

  const roomName =
    typeof req.body?.roomName === "string"
      ? req.body.roomName.trim()
      : "";

  if (!title) {
    return res.status(400).json({
      error: "Введи название эфира"
    });
  }

  if (!validRoomName(roomName)) {
    return res.status(400).json({
      error: "Некорректное имя комнаты"
    });
  }

  try {
    const { data: existing, error: lookupError } = await supabase
      .from("live_streams")
      .select("id")
      .eq("room_name", roomName)
      .maybeSingle();

    if (lookupError) throw lookupError;

    let result;

    if (existing) {
      result = await supabase
        .from("live_streams")
        .update({
          title,
          status: "live",
          started_at: new Date().toISOString(),
          ended_at: null
        })
        .eq("room_name", roomName)
        .select("id,title,room_name,status,started_at")
        .single();
    } else {
      result = await supabase
        .from("live_streams")
        .insert({
          title,
          room_name: roomName,
          status: "live",
          started_at: new Date().toISOString(),
          ended_at: null
        })
        .select("id,title,room_name,status,started_at")
        .single();
    }

    if (result.error) throw result.error;

    res.json({
      success: true,
      stream: result.data,
      roomName: result.data.room_name
    });
  } catch (error) {
    console.error("Start stream error:", error);
    res.status(500).json({
      error: "Не удалось создать эфир. Проверь таблицу live_streams."
    });
  }
});

/* Остановка эфира */

app.post("/api/streams/stop", async (req, res) => {
  if (!requireDatabase(res)) return;
  if (!requireHost(req, res)) return;

  const roomName =
    typeof req.body?.roomName === "string"
      ? req.body.roomName.trim()
      : "";

  if (!validRoomName(roomName)) {
    return res.status(400).json({
      error: "Некорректное имя комнаты"
    });
  }

  try {
    const { error } = await supabase
      .from("live_streams")
      .update({
        status: "ended",
        ended_at: new Date().toISOString()
      })
      .eq("room_name", roomName)
      .eq("status", "live");

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error("Stop stream error:", error);
    res.status(500).json({ error: "Не удалось остановить эфир" });
  }
});

/* Токен LiveKit: ведущий публикует видео, зритель смотрит */

app.get("/api/livekit/token", async (req, res) => {
  if (!requireLiveKit(res)) return;

  const roomName =
    typeof req.query.roomName === "string"
      ? req.query.roomName.trim()
      : "";

  if (!validRoomName(roomName)) {
    return res.status(400).json({ error: "Некорректное имя комнаты" });
  }

  const isHost = Boolean(hostIdFromRequest(req));

  if (isHost) {
    if (!requireDatabase(res)) return;

    try {
      const { data, error } = await supabase
        .from("live_streams")
        .select("id")
        .eq("room_name", roomName)
        .eq("status", "live")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({
          error: "Сначала создай эфир"
        });
      }
    } catch (error) {
      console.error("Host token check:", error);
      return res.status(500).json({
        error: "Не удалось проверить эфир"
      });
    }
  } else {
    if (!requireDatabase(res)) return;

    try {
      const { data, error } = await supabase
        .from("live_streams")
        .select("id")
        .eq("room_name", roomName)
        .eq("status", "live")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({
          error: "Эфир не найден или завершён"
        });
      }
    } catch (error) {
      console.error("Viewer token check:", error);
      return res.status(500).json({
        error: "Не удалось проверить эфир"
      });
    }
  }

  try {
    const identity = isHost
      ? "host-" + crypto.randomUUID()
      : "viewer-" + crypto.randomUUID();

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
      canPublishData: isHost
    });

    res.json({
      token: await token.toJwt(),
      url: LIVEKIT_URL
    });
  } catch (error) {
    console.error("LiveKit token error:", error);
    res.status(500).json({
      error: "Не удалось создать токен LiveKit"
    });
  }
});

/* Чат */

app.get("/api/chat", async (req, res) => {
  if (!requireDatabase(res)) return;

  const roomName =
    typeof req.query.roomName === "string"
      ? req.query.roomName.trim()
      : "";

  if (!validRoomName(roomName)) {
    return res.status(400).json({ error: "Некорректная комната" });
  }

  try {
    const { data, error } = await supabase
      .from("live_messages")
      .select("id,room_name,participant_name,message,created_at")
      .eq("room_name", roomName)
      .order("id", { ascending: true })
      .limit(100);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("Chat read error:", error);
    res.status(500).json({ error: "Не удалось загрузить чат" });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!requireDatabase(res)) return;

  const roomName =
    typeof req.body?.roomName === "string"
      ? req.body.roomName.trim()
      : "";

  const participantName =
    typeof req.body?.participantName === "string"
      ? req.body.participantName.trim().slice(0, 40)
      : "Гость";

  const message =
    typeof req.body?.message === "string"
      ? req.body.message.trim().slice(0, 1000)
      : "";

  if (!validRoomName(roomName) || !message) {
    return res.status(400).json({
      error: "Укажи эфир и текст сообщения"
    });
  }

  try {
    const { data: stream, error: streamError } = await supabase
      .from("live_streams")
      .select("id")
      .eq("room_name", roomName)
      .eq("status", "live")
      .maybeSingle();

    if (streamError) throw streamError;

    if (!stream) {
      return res.status(404).json({ error: "Эфир завершён" });
    }

    const { data, error } = await supabase
      .from("live_messages")
      .insert({
        room_name: roomName,
        participant_name: participantName || "Гость",
        message
      })
      .select("id,room_name,participant_name,message,created_at")
      .single();

    if (error) throw error;

    res.json({ success: true, message: data });
  } catch (error) {
    console.error("Chat write error:", error);
    res.status(500).json({ error: "Не удалось отправить сообщение" });
  }
});

/* Каталог подарков */

app.get("/api/gifts", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const { data, error } = await supabase
      .from("gifts")
      .select("id,name,emoji,price,active")
      .eq("active", true)
      .order("price", { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error("Gifts error:", error);
    res.status(500).json({ error: "Не удалось загрузить подарки" });
  }
});

/* Гостевой кошелёк */

app.get("/api/wallet", async (req, res) => {
  if (!requireDatabase(res)) return;

  if (!GUEST_SESSION_SECRET) {
    return res.status(503).json({
      error: "Добавь GUEST_SESSION_SECRET в Render"
    });
  }

  try {
    let guestId = guestIdFromRequest(req);

    if (!guestId) {
      guestId = crypto.randomUUID();
      setSignedCookie(res, GUEST_COOKIE, guestId, GUEST_SESSION_SECRET);
    }

    const { error: insertError } = await supabase
      .from("live_wallets")
      .upsert(
        { guest_id: guestId },
        {
          onConflict: "guest_id",
          ignoreDuplicates: true
        }
      );

    if (insertError) throw insertError;

    const { data, error } = await supabase
      .from("live_wallets")
      .select("balance")
      .eq("guest_id", guestId)
      .single();

    if (error) throw error;

    res.json({ balance: data.balance });
  } catch (error) {
    console.error("Wallet error:", error);
    res.status(500).json({
      error: "Не удалось загрузить баланс"
    });
  }
});

/* Отправка подарка */

app.post("/api/gifts/send", async (req, res) => {
  if (!requireDatabase(res)) return;

  if (!GUEST_SESSION_SECRET) {
    return res.status(503).json({
      error: "Добавь GUEST_SESSION_SECRET в Render"
    });
  }

  try {
    const guestId = guestIdFromRequest(req);

    if (!guestId) {
      return res.status(401).json({
        error: "Обнови страницу и повтори"
      });
    }

    const roomName =
      typeof req.body?.roomName === "string"
        ? req.body.roomName.trim()
        : "";

    const giftId = Number(req.body?.giftId);

    if (
      !validRoomName(roomName) ||
      !Number.isSafeInteger(giftId) ||
      giftId <= 0
    ) {
      return res.status(400).json({
        error: "Неверный эфир или подарок"
      });
    }

    const { data, error } = await supabase.rpc("send_live_gift", {
      p_guest_id: guestId,
      p_room_name: roomName,
      p_gift_id: giftId
    });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error("Send gift error:", error);
    res.status(400).json({
      error: error.message || "Не удалось отправить подарок"
    });
  }
});

/* Обработка неизвестных адресов */

app.use((req, res) => {
  res.status(404).json({ error: "Маршрут не найден" });
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE запущен на порту ${PORT}`);
});
