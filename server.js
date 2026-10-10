"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;

app.use(express.json({ limit: "20kb" }));

let supabase = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", site: "Y-FETISH LIVE" });
});

app.get("/", (req, res, next) => {
  res.sendFile(path.join(ROOT, "index.html"), (err) => {
    if (err) next();
  });
});

app.get("/live.html", (req, res, next) => {
  res.sendFile(path.join(ROOT, "live.html"), (err) => {
    if (err) next();
  });
});

app.get("/app.js", (req, res, next) => {
  res.type("application/javascript").sendFile(path.join(ROOT, "app.js"), (err) => {
    if (err) next();
  });
});

app.get("/style.css", (req, res, next) => {
  res.type("text/css").sendFile(path.join(ROOT, "style.css"), (err) => {
    if (err) next();
  });
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
      .select("id,title,host_id,room_name,started_at,profiles(username,avatar_url)")
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Streams error:", error.message);
    res.status(500).json({ error: "Could not load streams" });
  }
});

// Получить последние сообщения комнаты
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

// Ограничение частоты отправки сообщений
const chatRateLimits = new Map();

app.post("/api/chat", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const now = Date.now();
  const ip = req.ip || "unknown";
  const rate = chatRateLimits.get(ip) || { count: 0, resetAt: now + 10000 };

  if (now > rate.resetAt) {
    rate.count = 0;
    rate.resetAt = now + 10000;
  }

  if (rate.count >= 6) {
    chatRateLimits.set(ip, rate);
    return res.status(429).json({
      error: "Слишком много сообщений. Подожди немного."
    });
  }

  const body = req.body || {};
  const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
  const participantName =
    typeof body.participantName === "string"
      ? body.participantName.trim()
      : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (
    !roomName ||
    roomName.length > 100 ||
    !participantName ||
    participantName.length > 50 ||
    !message ||
    message.length > 300
  ) {
    return res.status(400).json({ error: "Проверь текст сообщения" });
  }

  rate.count += 1;
  chatRateLimits.set(ip, rate);

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
    const { roomName, participantName } = req.body || {};

    if (
      typeof roomName !== "string" ||
      typeof participantName !== "string" ||
      !roomName.trim() ||
      !participantName.trim() ||
      roomName.length > 100 ||
      participantName.length > 50
    ) {
      return res.status(400).json({ error: "Invalid room or participant name" });
    }

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(503).json({ error: "LiveKit is not configured" });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: `guest-${crypto.randomUUID()}`,
        name: participantName.trim(),
        ttl: "1h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName.trim(),
      canSubscribe: true,
      canPublish: false,
      canPublishData: true
    });

    res.json({
      serverUrl: process.env.LIVEKIT_URL,
      token: await token.toJwt()
    });
  } catch (error) {
    console.error("LiveKit token error:", error.message);
    res.status(500).json({ error: "Could not create LiveKit token" });
  }
});

app.use((req, res) => {
  res.status(404).send("Страница не найдена");
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
