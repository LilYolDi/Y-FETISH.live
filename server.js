const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

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

app.get("/api/gifts", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const { data, error } = await supabase
    .from("gifts")
    .select("id,name,emoji,price")
    .eq("active", true)
    .order("price");

  if (error) {
    return res.status(500).json({ error: "Could not load gifts" });
  }

  res.json(data);
});

app.get("/api/streams", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const { data, error } = await supabase
    .from("live_streams")
    .select("id,title,host_id,room_name,started_at,profiles(username,avatar_url)")
    .eq("status", "live")
    .order("started_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Could not load streams" });
  }

  res.json(data);
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomName, participantName, isHost } = req.body || {};

    if (!roomName || !participantName) {
      return res.status(400).json({
        error: "roomName and participantName are required"
      });
    }

    if (
      typeof roomName !== "string" ||
      typeof participantName !== "string" ||
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
        identity: `guest-${require("crypto").randomUUID()}`,
        name: participantName.trim() || "Guest",
        ttl: "1h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canSubscribe: true,
      canPublish: Boolean(isHost),
      canPublishData: true
    });

    const jwt = await token.toJwt();

    res.json({
      serverUrl: process.env.LIVEKIT_URL,
      token: jwt
    });
  } catch (error) {
    console.error("LiveKit token error:", error.message);
    res.status(500).json({ error: "Could not create LiveKit token" });
  }
});

app.get("*path", (req, res, next) => {
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
