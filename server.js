
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;
const HOST_PASSWORD = process.env.HOST_PASSWORD || "";
const COOKIE_NAME = "yfetish_host_session";
const SESSION_MS = 6 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

let supabase = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  return left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

function signSession(payload) {
  return crypto
    .createHmac("sha256", HOST_PASSWORD)
    .update(payload)
    .digest("base64url");
}

function readCookies(req) {
  const result = {};

  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");

    if (index > 0) {
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

function isHost(req) {
  if (!HOST_PASSWORD) return false;

  const token = readCookies(req)[COOKIE_NAME];
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  if (!safeEqual(signSession(payload), signature)) return false;

  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return Number.isFinite(session.exp) && session.exp > Date.now();
  } catch {
    return false;
  }
}

function requireHost(req, res, next) {
  if (!isHost(req)) {
    return res.status(401).json({
      error: "Сначала войди как ведущий"
    });
  }

  next();
}

function sendFile(name, type) {
  return (req, res, next) => {
    if (type) res.type(type);

    res.sendFile(path.join(ROOT, name), (err) => {
      if (err) next();
    });
  };
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", site: "Y-FETISH LIVE" });
});

app.get("/", sendFile("index.html"));
app.get("/live.html", sendFile("live.html"));
app.get("/host.html", sendFile("host.html"));
app.get("/app.js", sendFile("app.js", "application/javascript"));
app.get("/host.js", sendFile("host.js", "application/javascript"));
app.get("/style.css", sendFile("style.css", "text/css"));

app.get("/api/host/status", (req, res) => {
  res.json({ authenticated: isHost(req) });
});

const loginAttempts = new Map();

app.post("/api/host/login", (req, res) => {
  if (!HOST_PASSWORD) {
    return res.status(503).json({
      error: "HOST_PASSWORD не настроен в Render"
    });
  }

  const ip = req.ip || "unknown";
  const now = Date.now();
  let attempt = loginAttempts.get(ip);

  if (!attempt || now - attempt.start > 10 * 60 * 1000) {
    attempt = { start: now, count: 0 };
  }

  if (attempt.count >= 10) {
    loginAttempts.set(ip, attempt);
    return res.status(429).json({
      error: "Слишком много попыток. Попробуй через 10 минут."
    });
  }

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!safeEqual(password, HOST_PASSWORD)) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);

    return res.status(401).json({
      error: "Неверный пароль"
    });
  }

  loginAttempts.delete(ip);

  const payload = Buffer.from(
    JSON.stringify({ exp: now + SESSION_MS }),
    "utf8"
  ).toString("base64url");

  const signature = signSession(payload);

  res.cookie(COOKIE_NAME, `${payload}.${signature}`, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MS
  });

  res.json({ success: true });
});

app.post("/api/host/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/"
  });

  res.json({ success: true });
});

app.get("/api/gifts", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { data, error } = await supabase
      .from("gifts")
      .select("id,name,emoji,price")
      .eq("active", true)
      .order("price");

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Gifts error:", error.message);
    res.status(500).json({ error: "Could not load gifts" });
  }
});

app.get("/api/streams", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { data, error } = await supabase
      .from("live_streams")
      .select(
        "id,title,host_id,room_name,started_at,profiles(username,avatar_url)"
      )
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Streams error:", error.message);
    res.status(500).json({ error: "Could not load streams" });
  }
});

app.get("/api/chat", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const roomName = String(req.query.room || "").trim();

  if (!roomName || roomName.length > 100) {
    return res.status(400).json({ error: "Invalid room" });
  }

  try {
    const { data, error } = await supabase
      .from("live_messages")
      .select("id,room_name,participant_name,message,created_at")
      .eq("room_name", roomName)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json((data || []).reverse());
  } catch (error) {
    console.error("Chat read error:", error.message);
    res.status(500).json({ error: "Could not load chat" });
  }
});

const chatLimits = new Map();

app.post("/api/chat", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const now = Date.now();
  const ip = req.ip || "unknown";
  let rate = chatLimits.get(ip);

  if (!rate || now > rate.resetAt) {
    rate = { count: 0, resetAt: now + 10000 };
  }

  if (rate.count >= 6) {
    chatLimits.set(ip, rate);
    return res.status(429).json({
      error: "Слишком много сообщений. Подожди немного."
    });
  }

  const roomName =
    typeof req.body?.roomName === "string"
      ? req.body.roomName.trim()
      : "";
  const participantName =
    typeof req.body?.participantName === "string"
      ? req.body.participantName.trim()
      : "";
  const message =
    typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

  if (
    !roomName || roomName.length > 100 ||
    !participantName || participantName.length > 50 ||
    !message || message.length > 300
  ) {
    return res.status(400).json({ error: "Проверь текст сообщения" });
  }

  rate.count += 1;
  chatLimits.set(ip, rate);

  try {
    const { data, error } = await supabase
      .from("live_messages")
      .insert({
        room_name: roomName,
        participant_name: participantName,
        message
      })
      .select("id,room_name,participant_name,message,created_at")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error("Chat send error:", error.message);
    res.status(500).json({ error: "Не удалось отправить сообщение" });
  }
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomName, participantName, isHost: wantsHost } = req.body || {};

    if (
      typeof roomName !== "string" ||
      typeof participantName !== "string" ||
      !roomName.trim() || roomName.length > 100 ||
      !participantName.trim() || participantName.length > 50
    ) {
      return res.status(400).json({
        error: "Invalid room or participant name"
      });
    }

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(503).json({
        error: "LiveKit is not configured"
      });
    }

    if (wantsHost && !isHost(req)) {
      return res.status(401).json({
        error: "Вход ведущего не выполнен"
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: wantsHost
          ? `host-${crypto.randomUUID()}`
          : `guest-${crypto.randomUUID()}`,
        name: participantName.trim(),
        ttl: "1h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName.trim(),
      canSubscribe: true,
      canPublish: Boolean(wantsHost && isHost(req)),
      canPublishData: true
    });

    res.json({
      serverUrl: process.env.LIVEKIT_URL,
      token: await token.toJwt()
    });
  } catch (error) {
    console.error("LiveKit token error:", error.message);
    res.status(500).json({
      error: "Could not create LiveKit token"
    });
  }
});

app.use((req, res) => {
  res.status(404).send("Страница не найдена");
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
