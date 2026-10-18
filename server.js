
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

/* Сохраняем исходное тело запроса для проверки подписи webhook */
app.use(express.json({
  limit: "1mb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "";
const ADMIN_COOKIE = "yfetish_live_admin";
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

/* AGDor Pay: секреты задаются в Render Environment */
const AGDOR_API_KEY =
  process.env.AURORA_API_KEY ||
  process.env["Aurora API Key"] ||
  "";

const AGDOR_PROJECT_CODE =
  process.env.AURORA_PROJECT_CODE ||
  process.env["Aurora Project Code"] ||
  "prj_fccc0f34";

const AGDOR_WEBHOOK_SECRET =
  process.env.DOOR_WEBHOOK_SECRET ||
  process.env["Door Webhook Secret"] ||
  "";

const AGDOR_WALLET_CODE = "usdt_trc20_60e5a3a0";
const AGDOR_INVOICE_URL = "https://agdorpay.com/api?r=create_invoice";

/* Пакеты монет и их цена в USDT */
const COIN_PACKAGES = Object.freeze({
  200: { price: 2 },
  400: { price: 10 },
  1000: { price: 20 },
  2500: { price: 50 },
  5000: { price: 100 },
  10000: { price: 180 }
});

/* Настройки заработка от подарков */
const COINS_PER_USD = 100;
const HOST_EARNINGS_SHARE = 0.7;
const HOST_EARNINGS_GOAL_USD = 100;
const PLATFORM_COMMISSION_SHARE = 0.3;
const HOST_WITHDRAWAL_MINIMUM_USD = 100;

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

function adminSignature(expires) {
  return crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(String(expires))
    .digest("hex");
}

function getAdminSession(req) {
  if (!ADMIN_SESSION_SECRET) return null;

  const value = getCookie(req, ADMIN_COOKIE);
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 2) return null;

  const [expires, signature] = parts;

  if (!/^\d+$/.test(expires)) return null;
  if (Number(expires) <= Date.now()) return null;

  if (!safeEqual(signature, adminSignature(expires))) {
    return null;
  }

  return { expires: Number(expires) };
}

function requireAdmin(req, res, next) {
  if (!getAdminSession(req)) {
    return res.status(401).json({
      error: "Требуется вход администратора"
    });
  }

  next();
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

app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(__dirname, "favicon.png"));
});
                            
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
  "withdraw.html",
  "admin.html",
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

/* =========================================================
   AGDor Pay — создание счёта и подтверждение покупки монет
   ========================================================= */

/*
 * Создание счёта.
 * Клиент передаёт количество монет, а цену сервер берёт
 * только из COIN_PACKAGES, не доверяя цене с браузера.
 */
app.post("/api/payments/create", requireUser, async (req, res) => {
  let externalId = null;
  let pendingCreated = false;

  try {
    if (!AGDOR_API_KEY || !AGDOR_PROJECT_CODE) {
      return res.status(503).json({
        error: "Оплата временно не настроена."
      });
    }

    const coins = Number(req.body?.coins);
    const pack = COIN_PACKAGES[coins];

    if (!Number.isSafeInteger(coins) || !pack) {
      return res.status(400).json({
        error: "Выбери один из доступных пакетов монет."
      });
    }

    externalId = crypto.randomUUID();

    /*
     * В существующей таблице coin_transactions используется
     * поле create_at. Новая таблица не требуется.
     */
    const { error: insertError } = await supabase
      .from("coin_transactions")
      .insert({
        user_id: req.user.id,
        amount: coins,
        transaction_type: "purchase_pending",
        payment_reference: externalId
      });

    if (insertError) throw insertError;

    pendingCreated = true;

    const form = new URLSearchParams({
      amount: String(pack.price),
      wallet_code: AGDOR_WALLET_CODE,
      external_id: externalId,
      customer_id: req.user.id
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;

    try {
      response = await fetch(AGDOR_INVOICE_URL, {
        method: "POST",
        headers: {
          "X-Project-Code": AGDOR_PROJECT_CODE,
          "X-API-Key": AGDOR_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString(),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error("AGDor Pay вернул ответ не в формате JSON");
    }

    if (!response.ok) {
      console.error("AGDor Pay HTTP error:", response.status, result);
      throw new Error("Не удалось создать платёжный счёт");
    }

    const invoice = result?.data || result?.result?.data || result?.result || result;

    const paymentUrl =
      invoice?.payment_url ||
      invoice?.paymentUrl ||
      invoice?.checkout_url ||
      invoice?.checkoutUrl ||
      invoice?.url;

    if (
      result?.success === false ||
      result?.error ||
      !paymentUrl ||
      typeof paymentUrl !== "string"
    ) {
      console.error("Неожиданный ответ AGDor Pay:", result);
      throw new Error("AGDor Pay не вернул ссылку на оплату");
    }

    let parsedPaymentUrl;

    try {
      parsedPaymentUrl = new URL(paymentUrl);
    } catch {
      throw new Error("AGDor Pay вернул неправильную ссылку");
    }

    if (parsedPaymentUrl.protocol !== "https:") {
      throw new Error("AGDor Pay вернул небезопасную ссылку");
    }

    res.json({
      success: true,
      payment_url: parsedPaymentUrl.toString(),
      external_id: externalId,
      coins,
      amount: pack.price,
      currency: "USDT",
      network: "TRC20"
    });
  } catch (error) {
    console.error("Создание платежа AGDor Pay:", error);

    if (pendingCreated && externalId) {
      const { error: cleanupError } = await supabase
        .from("coin_transactions")
        .delete()
        .eq("payment_reference", externalId)
        .eq("user_id", req.user.id)
        .eq("transaction_type", "purchase_pending");

      if (cleanupError) {
        console.error(
          "Не удалось удалить незавершённую запись платежа:",
          cleanupError
        );
      }
    }

    res.status(502).json({
      error: "Не удалось создать счёт на оплату. Попробуй ещё раз."
    });
  }
});

/* Webhook AGDor Pay */


/* Webhook AGDor Pay */

app.post("/api/payments/webhook", async (req, res) => {
  try {
    if (!AGDOR_WEBHOOK_SECRET) {
      console.error("Не задан DOOR_WEBHOOK_SECRET");

      return res.status(503).json({
        error: "Webhook не настроен"
      });
    }

    const timestamp =
      req.headers["x-payment-timestamp"] ||
      req.headers["x-webhook-timestamp"];

    const signatureHeader =
      req.headers["x-payment-signature"] ||
      req.headers["x-webhook-signature"];

    if (
      typeof timestamp !== "string" ||
      typeof signatureHeader !== "string" ||
      !req.rawBody
    ) {
      return res.status(400).json({
        error: "Отсутствует подпись webhook"
      });
    }

    const timestampNumber = Number(timestamp);

    if (!Number.isFinite(timestampNumber)) {
      return res.status(400).json({
        error: "Неверный timestamp"
      });
    }

    const timestampMs = timestampNumber < 1e12
      ? timestampNumber * 1000
      : timestampNumber;

    if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
      return res.status(401).json({
        error: "Webhook просрочен"
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", AGDOR_WEBHOOK_SECRET)
      .update(`${timestamp}.${req.rawBody.toString("utf8")}`)
      .digest("hex");

    const receivedSignature = signatureHeader
      .replace(/^sha256=/i, "")
      .trim();

    if (
      !safeEqual(
        expectedSignature.toLowerCase(),
        receivedSignature.toLowerCase()
      )
    ) {
      return res.status(401).json({
        error: "Неверная подпись webhook"
      });
    }

    const payload = req.body || {};

    const eventType = String(
      payload.event_type ||
      payload.event ||
      payload.type ||
      ""
    );

    const data =
      payload.data ||
      payload.invoice ||
      payload;

    /*
     * Принимаем только подтверждённый платёж.
     * Одного статуса без правильного события недостаточно.
     */
    const status = String(
      data.status ||
      payload.status ||
      ""
    ).toLowerCase();

    if (
      eventType !== "invoice.confirmed" ||
      status !== "confirmed"
    ) {
      return res.json({
        success: true,
        ignored: true
      });
    }

    /*
     * Проверяем, что уведомление относится к нашему проекту.
     */
    const projectCode = cleanText(
      data.project_code ||
      payload.project_code,
      150
    );

    if (
      !projectCode ||
      projectCode !== AGDOR_PROJECT_CODE
    ) {
      return res.status(400).json({
        error: "Неверный проект платежа"
      });
    }

    const externalId = cleanText(
      data.external_id ||
      data.externalId ||
      data.merchant_reference,
      100
    );

    if (!externalId) {
      return res.status(400).json({
        error: "Не указан external_id"
      });
    }

    const { data: transaction, error: transactionError } =
      await supabase
        .from("coin_transactions")
        .select("*")
        .eq("payment_reference", externalId)
        .eq("transaction_type", "purchase_pending")
        .maybeSingle();

    if (transactionError) throw transactionError;

    /*
     * Повторная доставка уже обработанного webhook
     * не должна повторно начислять монеты.
     */
    if (!transaction) {
      const {
        data: alreadyProcessed,
        error: processedError
      } = await supabase
        .from("coin_transactions")
        .select("id")
        .eq("payment_reference", externalId)
        .eq("transaction_type", "purchase")
        .maybeSingle();

      if (processedError) throw processedError;

      if (alreadyProcessed) {
        return res.json({
          success: true,
          already_processed: true
        });
      }

      return res.status(404).json({
        error: "Покупка не найдена"
      });
    }

    const coins = Number(transaction.amount);
    const pack = COIN_PACKAGES[coins];

    if (!pack) {
      return res.status(400).json({
        error: "Неизвестный пакет монет"
      });
    }

    /*
     * Обе суммы обязательны.
     * amount_requested — цена выбранного пакета.
     * amount — точная сумма счёта с возможным смещением.
     */
    const requestedAmount = Number(data.amount_requested);
    const paidAmount = Number(data.amount);

    if (
      !Number.isFinite(requestedAmount) ||
      requestedAmount <= 0 ||
      Math.abs(requestedAmount - pack.price) > 0.000001
    ) {
      console.error("Цена заказа не совпала:", {
        externalId,
        expected: pack.price,
        received: data.amount_requested
      });

      return res.status(400).json({
        error: "Цена заказа не совпадает с пакетом"
      });
    }

    if (
      !Number.isFinite(paidAmount) ||
      paidAmount <= 0 ||
      paidAmount < requestedAmount
    ) {
      console.error("Некорректная сумма счёта:", {
        externalId,
        requestedAmount,
        paidAmount: data.amount
      });

      return res.status(400).json({
        error: "Некорректная сумма платежа"
      });
    }

    /*
     * Если AGDor передал customer_id, сверяем его
     * с владельцем ожидающей покупки.
     */
    const customerId = data.customer_id || payload.customer_id;

    if (
      customerId &&
      String(customerId) !== String(transaction.user_id)
    ) {
      return res.status(400).json({
        error: "Покупатель не совпадает с заказом"
      });
    }

    const currency = String(
      data.currency || ""
    ).toUpperCase();

    const network = String(
      data.network || ""
    ).toUpperCase();

    if (currency !== "USDT") {
      return res.status(400).json({
        error: "Неверная валюта платежа"
      });
    }

    if (
      network !== "TRC20" &&
      network !== "TRON" &&
      network !== "USDT_TRC20"
    ) {
      return res.status(400).json({
        error: "Неверная сеть платежа"
      });
    }

    /*
     * Начисление выполняет существующая атомарная
     * функция Supabase. Сам webhook баланс не меняет.
     */
    const {
      data: creditResult,
      error: creditError
    } = await supabase.rpc(
      "credit_coin_purchase",
      {
        p_external_id: externalId,
        p_coins: coins
      }
    );

    if (creditError) throw creditError;

    const creditStatus = creditResult?.status;

    if (creditStatus === "already_processed") {
      return res.json({
        success: true,
        already_processed: true
      });
    }

    if (creditStatus === "not_found") {
      return res.status(404).json({
        error: "Покупка не найдена"
      });
    }

    if (creditStatus !== "credited") {
      return res.status(409).json({
        error: "Невозможно обработать эту покупку"
      });
    }

    console.log("Покупка монет подтверждена:", {
      externalId,
      userId: transaction.user_id,
      coins
    });

    return res.json({
      success: true,
      credited: true
    });
  } catch (error) {
    console.error("Webhook AGDor Pay:", error);

    return res.status(500).json({
      error: "Не удалось обработать webhook"
    });
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

/* Подарки: список */

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

/*
 * Подарки: события для анимации у зрителей.
 * Клиент может опрашивать этот маршрут, передавая since —
 * время последнего полученного события.
 */
app.get("/api/gifts/events", async (req, res) => {
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
        error: "Эфир завершён"
      });
    }

    const requestedSince = cleanText(req.query.since, 50);
    const sinceTime = requestedSince
      ? Date.parse(requestedSince)
      : NaN;

    const since = Number.isFinite(sinceTime)
      ? new Date(sinceTime).toISOString()
      : new Date(Date.now() - 30000).toISOString();

    const { data: transactions, error } = await supabase
      .from("gift_transactions")
      .select("id, sender_id, receiver_id, stream_id, gift_id, quantity, total_coins, created_at")
      .eq("stream_id", stream.id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    const rows = transactions || [];

    if (!rows.length) {
      return res.json({
        success: true,
        events: []
      });
    }

    const giftIds = [
      ...new Set(rows.map(row => row.gift_id).filter(Boolean))
    ];

    const senderIds = [
      ...new Set(rows.map(row => row.sender_id).filter(Boolean))
    ];

    const requests = [];

    if (giftIds.length) {
      requests.push(
        supabase
          .from("gifts")
          .select("id, name, emoji, price")
          .in("id", giftIds)
      );
    } else {
      requests.push(Promise.resolve({ data: [], error: null }));
    }

    if (senderIds.length) {
      requests.push(
        supabase
          .from("user_profiles")
          .select("id, nickname")
          .in("id", senderIds)
      );
    } else {
      requests.push(Promise.resolve({ data: [], error: null }));
    }

    const [giftResult, profileResult] = await Promise.all(requests);

    if (giftResult.error) throw giftResult.error;
    if (profileResult.error) throw profileResult.error;

    const giftsById = new Map(
      (giftResult.data || []).map(gift => [String(gift.id), gift])
    );

    const namesById = new Map(
      (profileResult.data || []).map(profile => [
        profile.id,
        profile.nickname
      ])
    );

    const events = rows.map(row => {
      const gift = giftsById.get(String(row.gift_id));

      return {
        id: row.id,
        created_at: row.created_at,
        senderName: namesById.get(row.sender_id) || "Зритель",
        gift: gift
          ? {
              id: gift.id,
              name: gift.name,
              emoji: gift.emoji || "🎁",
              price: Number(gift.price || 0)
            }
          : {
              id: row.gift_id,
              name: "Подарок",
              emoji: "🎁",
              price: Number(row.total_coins || 0)
            },
        quantity: Number(row.quantity || 1),
        totalCoins: Number(row.total_coins || 0)
      };
    });

    return res.json({
      success: true,
      events
    });
  } catch (error) {
    sendError(res, error, "Не удалось загрузить события подарков");
  }
});

/*
 * Заработок ведущего.
 * 100 монет = $1 общего объёма подарков.
 * 50% получает ведущий, 50% — платформа.
 */

/* =========================================================
   ЗАРАБОТОК ВЕДУЩЕГО
   100 монет = $1 стоимости подарков.
   Ведущему — 70%, платформе — 30%.
   Данные берём из host_earnings, созданной триггером Supabase.
   ========================================================= */

app.get("/api/host/earnings", requireHostAccess, async (req, res) => {
  try {
    const hostId = req.hostId;

    if (!hostId) {
      return res.status(400).json({
        error: "Не удалось определить ведущего"
      });
    }

    const [
      earningsResult,
      withdrawalsResult
    ] = await Promise.all([
      supabase
        .from("host_earnings")
        .select(
          "total_coins, host_amount_cents, platform_amount_cents"
        )
        .eq("host_id", hostId),

      supabase
        .from("withdrawal_requests")
        .select("amount_cents, status")
        .eq("host_id", hostId)
    ]);

    if (earningsResult.error) {
      throw earningsResult.error;
    }

    if (withdrawalsResult.error) {
      throw withdrawalsResult.error;
    }

    const earnings = earningsResult.data || [];
    const withdrawals = withdrawalsResult.data || [];

    const totalCoins = earnings.reduce(
      (sum, row) => sum + Number(row.total_coins || 0),
      0
    );

    const hostCents = earnings.reduce(
      (sum, row) => sum + Number(row.host_amount_cents || 0),
      0
    );

    const platformCents = earnings.reduce(
      (sum, row) => sum + Number(row.platform_amount_cents || 0),
      0
    );

    /*
     * Pending и approved — деньги уже зарезервированы.
     * Paid тоже остаётся в сумме заявок, поскольку заработок
     * в host_earnings не удаляется после выплаты.
     * Rejected снова освобождает доступную сумму.
     */
    const reservedCents = withdrawals.reduce((sum, row) => {
      if (
        ["pending", "approved", "paid"].includes(row.status)
      ) {
        return sum + Number(row.amount_cents || 0);
      }

      return sum;
    }, 0);

    const availableCents = Math.max(
      0,
      hostCents - reservedCents
    );

    const grossCents = Math.round(
      totalCoins / COINS_PER_USD * 100
    );

    const hostEarningsUsd = hostCents / 100;
    const platformCommissionUsd = platformCents / 100;
    const grossUsd = grossCents / 100;
    const availableUsd = availableCents / 100;
    const reservedUsd = reservedCents / 100;

    const progressPercent = Math.min(
      100,
      Math.round(
        availableUsd / HOST_EARNINGS_GOAL_USD * 100
      )
    );

    return res.json({
      success: true,
      currency: "USD",
      totalCoins,
      grossUsd: Number(grossUsd.toFixed(2)),
      hostEarningsUsd: Number(hostEarningsUsd.toFixed(2)),
      platformCommissionUsd: Number(
        platformCommissionUsd.toFixed(2)
      ),
      hostSharePercent: HOST_EARNINGS_SHARE * 100,
      platformCommissionPercent:
        PLATFORM_COMMISSION_SHARE * 100,
      coinsPerUsd: COINS_PER_USD,
      goalUsd: HOST_EARNINGS_GOAL_USD,
      withdrawalMinimumUsd: HOST_WITHDRAWAL_MINIMUM_USD,
      reservedUsd: Number(reservedUsd.toFixed(2)),
      availableUsd: Number(availableUsd.toFixed(2)),
      progressPercent
    });
  } catch (error) {
    sendError(
      res,
      error,
      "Не удалось загрузить заработок ведущего"
    );
  }
});


/* =========================================================
   ВЫВОД ЗАРАБОТКА ВЕДУЩЕГО
   Минимум $100. Только USDT TRC20.
   Заявка создаётся со статусом pending.
   Автоматическую отправку криптовалюты этот маршрут не делает.
   ========================================================= */

app.post(
  "/api/host/withdrawals",
  requireHostAccess,
  async (req, res) => {
    try {
      const hostId = req.hostId;

      const amount = Number(req.body?.amountUsd);
      const walletAddress = cleanText(
        req.body?.walletAddress,
        100
      );

      if (!hostId) {
        return res.status(400).json({
          error: "Не удалось определить ведущего"
        });
      }

      if (
        !Number.isFinite(amount) ||
        !Number.isSafeInteger(amount * 100) ||
        amount < HOST_WITHDRAWAL_MINIMUM_USD
      ) {
        return res.status(400).json({
          error: "Минимальная сумма вывода — $100"
        });
      }

      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress)) {
        return res.status(400).json({
          error: "Укажи правильный адрес кошелька USDT TRC20"
        });
      }

      const amountCents = Math.round(amount * 100);

      const { data, error } = await supabase.rpc(
        "request_host_withdrawal",
        {
          p_host_id: hostId,
          p_amount_cents: amountCents,
          p_wallet_address: walletAddress
        }
      );

      if (error) {
        console.error("Ошибка заявки на вывод:", error);

        const message = error.message || "";

        if (
          message.includes("Недостаточно доступного заработка") ||
          message.includes("Минимальный вывод") ||
          message.includes("Неверный адрес USDT TRC20") ||
          message.includes("Профиль ведущего не найден")
        ) {
          return res.status(400).json({
            error: message
          });
        }

        return res.status(500).json({
          error: "Не удалось создать заявку на вывод"
        });
      }

      return res.json({
        success: true,
        request: data,
        message: "Заявка на вывод создана и ожидает обработки."
      });
    } catch (error) {
      return sendError(
        res,
        error,
        "Не удалось создать заявку на вывод"
      );
    }
  }
);

/* История заявок на вывод */

app.get(
  "/api/host/withdrawals",
  requireHostAccess,
  async (req, res) => {
    try {
      const hostId = req.hostId;

      if (!hostId) {
        return res.status(400).json({
          error: "Не удалось определить ведущего"
        });
      }

      const { data, error } = await supabase
        .from("withdrawal_requests")
        .select(
          "id, amount_cents, wallet_address, network, status, created_at, processed_at, admin_note"
        )
        .eq("host_id", hostId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const requests = (data || []).map(row => ({
        ...row,
        amountUsd: Number(
          (Number(row.amount_cents || 0) / 100).toFixed(2)
        )
      }));

      return res.json({
        success: true,
        requests
      });
    } catch (error) {
      return sendError(
        res,
        error,
        "Не удалось загрузить историю заявок на вывод"
      );
    }
  }
);


/* Кошелёк гостя — оставляем без изменений */

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

/* Отправка подарка за купленные монеты зарегистрированного пользователя */

app.post("/api/gifts/send", requireUser, async (req, res) => {
  try {
    const roomName = cleanText(req.body?.roomName, 100);
    const giftId = req.body?.giftId;

    if (
      !validRoomName(roomName) ||
      typeof giftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(giftId)
    ) {
      return res.status(400).json({
        error: "Неверные данные подарка"
      });
    }

    const stream = await getLiveStream(roomName);

    if (!stream || !stream.host_id) {
      return res.status(404).json({
        error: "Эфир завершён или ведущий не найден"
      });
    }

    const { data, error } = await supabase.rpc("send_live_gift", {
      p_sender_id: req.user.id,
      p_room_name: roomName,
      p_gift_id: giftId
    });

    if (error) {
      console.error("Ошибка отправки подарка:", error);

      const message = error.message || "";

      if (
        message.includes("Недостаточно монет") ||
        message.includes("Подарок не найден") ||
        message.includes("Эфир не найден")
      ) {
        return res.status(400).json({
          error: message
        });
      }

      return res.status(500).json({
        error: "Не удалось отправить подарок"
      });
    }

    return res.json({
      success: true,
      ...(data && typeof data === "object" ? data : {})
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Не удалось отправить подарок"
    );
  }
});


/* =========================================================
   ПОДПИСКИ ПОЛЬЗОВАТЕЛЕЙ
   Таблица Supabase: user_follows
   Поля: follower_id, following_id, created_at
   ========================================================= */

/* Получить количество подписчиков и подписок, проверить подписку */
app.get("/api/follows/:userId", async (req, res) => {
  try {
    const userId = cleanText(req.params.userId, 100);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
    ) {
      return res.status(400).json({
        error: "Неверный ID пользователя"
      });
    }

    const currentUser = await getUser(req);

    const [
      followersResult,
      followingResult,
      statusResult
    ] = await Promise.all([
      supabase
        .from("user_follows")
        .select("follower_id", { count: "exact", head: true })
        .eq("following_id", userId),

      supabase
        .from("user_follows")
        .select("following_id", { count: "exact", head: true })
        .eq("follower_id", userId),

      currentUser
        ? supabase
            .from("user_follows")
            .select("follower_id")
            .eq("follower_id", currentUser.id)
            .eq("following_id", userId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);

    if (followersResult.error) throw followersResult.error;
    if (followingResult.error) throw followingResult.error;
    if (statusResult.error) throw statusResult.error;

    return res.json({
      success: true,
      userId,
      followersCount: followersResult.count || 0,
      followingCount: followingResult.count || 0,
      isFollowing: Boolean(statusResult.data),
      isOwnProfile: currentUser?.id === userId
    });
  } catch (error) {
    return sendError(res, error, "Не удалось загрузить подписки");
  }
});

/* Подписаться на пользователя */
app.post("/api/follows/:userId", requireUser, async (req, res) => {
  try {
    const followingId = cleanText(req.params.userId, 100);
    const followerId = req.user.id;

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(followingId)
    ) {
      return res.status(400).json({
        error: "Неверный ID пользователя"
      });
    }

    if (followerId === followingId) {
      return res.status(400).json({
        error: "Нельзя подписаться на самого себя"
      });
    }

    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", followingId)
      .maybeSingle();

    if (targetError) throw targetError;

    if (!target) {
      return res.status(404).json({
        error: "Пользователь не найден"
      });
    }

    const { error: insertError } = await supabase
      .from("user_follows")
      .upsert(
        {
          follower_id: followerId,
          following_id: followingId
        },
        {
          onConflict: "follower_id,following_id",
          ignoreDuplicates: true
        }
      );

    if (insertError) throw insertError;

    return res.json({
      success: true,
      isFollowing: true
    });
  } catch (error) {
    return sendError(res, error, "Не удалось подписаться на пользователя");
  }
});

/* Отписаться от пользователя */
app.delete("/api/follows/:userId", requireUser, async (req, res) => {
  try {
    const followingId = cleanText(req.params.userId, 100);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(followingId)
    ) {
      return res.status(400).json({
        error: "Неверный ID пользователя"
      });
    }

    const { error } = await supabase
      .from("user_follows")
      .delete()
      .eq("follower_id", req.user.id)
      .eq("following_id", followingId);

    if (error) throw error;

    return res.json({
      success: true,
      isFollowing: false
    });
  } catch (error) {
    return sendError(res, error, "Не удалось отменить подписку");
  }
});

/* Список пользователей, на которых подписан текущий аккаунт */
app.get("/api/follows/me/list", requireUser, async (req, res) => {
  try {
    const { data: follows, error } = await supabase
      .from("user_follows")
      .select("following_id, created_at")
      .eq("follower_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = follows || [];
    const ids = [...new Set(rows.map(row => row.following_id))];

    if (!ids.length) {
      return res.json({
        success: true,
        users: []
      });
    }

    const { data: profiles, error: profilesError } = await supabase
      .from("user_profiles")
      .select("id, nickname")
      .in("id", ids);

    if (profilesError) throw profilesError;

    const names = new Map(
      (profiles || []).map(profile => [
        profile.id,
        profile.nickname
      ])
    );

    return res.json({
      success: true,
      users: rows.map(row => ({
        id: row.following_id,
        nickname: names.get(row.following_id) || "Пользователь",
        followedAt: row.created_at
      }))
    });
  } catch (error) {
    return sendError(res, error, "Не удалось загрузить список подписок");
  }
});



/* Админ-панель: вход и управление выплатами */

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) {
    return res.status(503).json({
      error: "Вход администратора не настроен в Render"
    });
  }

  const password = String(req.body?.password || "");

  if (!safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      error: "Неверный пароль администратора"
    });
  }

  const expires = String(Date.now() + ADMIN_SESSION_MS);
  const signature = adminSignature(expires);
  const value = `${expires}.${signature}`;

  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${value}; HttpOnly; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}; SameSite=Lax; Secure`
  );

  return res.json({ success: true });
});

app.get("/api/admin/session", (req, res) => {
  return res.json({
    authenticated: Boolean(getAdminSession(req))
  });
});

app.post("/api/admin/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`
  );

  return res.json({ success: true });
});

app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const hostIds = [...new Set(
      (rows || []).map(row => row.host_id).filter(Boolean)
    )];

    let profiles = [];

    if (hostIds.length) {
      const { data, error: profilesError } = await supabase
        .from("profiles")
        .select("id, username")
        .in("id", hostIds);

      if (profilesError) throw profilesError;
      profiles = data || [];
    }

    const profileMap = new Map(
      profiles.map(profile => [String(profile.id), profile.username])
    );

    return res.json({
      withdrawals: (rows || []).map(row => ({
        ...row,
        host_username: profileMap.get(String(row.host_id)) || row.host_id,
        amountUsd: Number(row.amount_cents) / 100
      }))
    });
  } catch (error) {
    console.error("Admin withdrawals error:", error);
    return res.status(500).json({
      error: "Не удалось загрузить заявки на выплату"
    });
  }
});

app.patch("/api/admin/withdrawals/:id", requireAdmin, async (req, res) => {
  try {
    const allowedStatuses = [
      "pending",
      "approved",
      "paid",
      "rejected"
    ];

    const status = String(req.body?.status || "");
    const admin_note = String(req.body?.admin_note || "").slice(0, 1000);

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Недопустимый статус заявки"
      });
    }

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .update({
        status,
        admin_note,
        processed_at: status === "pending" ? null : new Date().toISOString()
      })
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: "Заявка не найдена"
      });
    }

    return res.json({
      success: true,
      withdrawal: data
    });
  } catch (error) {
    console.error("Admin update withdrawal error:", error);
    return res.status(500).json({
      error: "Не удалось сохранить изменения заявки"
    });
  }
});



/* Неизвестные API-маршруты — только после всех API-маршрутов */
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API-маршрут не найден"
  });
});

/* Неизвестные страницы */
app.use((req, res) => {
  res.status(404).send("Страница не найдена");
});

/* Запуск сервера — строго в самом конце */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Y-FETISH LIVE running on port ${PORT}`);
});
