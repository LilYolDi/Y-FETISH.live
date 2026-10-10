
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(ROOT));

let supabase = null;

if (
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    site: "Y-FETISH LIVE"
  });
});

app.get("/api/gifts", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: "Database not configured"
    });
  }

  try {
    const { data, error } = await supabase
      .from("gifts")
      .select("id,name,emoji,price")
      .eq("active", true)
      .order("price");

    if (error) {
      console.error("Gifts error:", error.message);
      return res.status(500).json({
        error: "Could not load gifts"
      });
    }

    res.json(data || []);
  } catch (error) {
    console.error("Gifts error:", error.message);
    res.status(500).json({
      error: "Could not load gifts"
    });
  }
});

app.get("/api/streams", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: "Database not configured"
    });
  }

  try {
    const { data, error } = await supabase
      .from("live_streams")
      .select(
        "id,title,host_id,room_name,started_at,profiles(username,avatar_url)"
      )
      .eq("status", "live")
      .order("started_at", { ascending: false });

    if (error) {
      console.error("Streams error:", error.message);
      return res.status(500).json({
        error: "Could not load streams"
      });
    }

    res.json(data || []);
  } catch (error) {
    console.error("Streams error:", error.message);
    res.status(500).json({
      error: "Could not load streams"
    });
  }
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const {
      roomName,
      participantName,
      isHost
    } = req.body || {};

    if (
      typeof roomName !== "string" ||
      typeof participantName !== "string" ||
      !roomName.trim() ||
      !participantName.trim() ||
      roomName.length > 100 ||
      participantName.length > 50
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

    // Публичные запросы не могут получить права ведущего.
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

    const jwt = await token.toJwt();

    res.json({
      serverUrl: process.env.LIVEKIT_URL,
      token: jwt
    });
  } catch (error) {
    console.error("LiveKit token error:", error.message);
    res.status(500).json({
      error: "Could not create LiveKit token"
    });
  }
});

// Главная страница
app.get("/", (req, res, next) => {
  res.sendFile(path.join(ROOT, "index.html"), (err) => {
    if (err) next();
  });
});

// Страница эфира
app.get("/live.html", (req, res, next) => {
  res.sendFile(path.join(ROOT, "live.html"), (err) => {
    if (err) next();
  });
});

// Остальные файлы и страницы
app.use((req, res, next) => {
  res.status(404).send("Страница не найдена");
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
