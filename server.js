const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/live.html", (req, res) => {
  res.sendFile(path.join(__dirname, "live.html"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

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

app.get("*path", (req, res, next) => {
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
