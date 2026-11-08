// Китайский дурак для Telegram (by Кащей): сервер игры + бот.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const R = require("./rules");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const DEV = process.env.DEV === "1" || process.argv.includes("--dev"); // локальная проверка в обычном браузере, без Telegram

if (!BOT_TOKEN && !DEV) {
  console.error("Не задан BOT_TOKEN. Добавь его в Environment Variables на хостинге.");
  process.exit(1);
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const HOOK_SECRET = BOT_TOKEN ? sha("hook" + BOT_TOKEN).slice(0, 40) : "dev";
const HOOK_PATH = "/tg/" + HOOK_SECRET.slice(0, 20);
let botUsername = process.env.BOT_USERNAME || "";

/* ---------------- Telegram API ---------------- */
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.error(`Telegram ${method}:`, j.description || res.status);
  return j.result;
}

const appUrl = code => PUBLIC_URL + "/" + (code ? `?room=${code}` : "");

async function onUpdate(u) {
  const m = u.message;
  if (!m || !m.text || !m.chat) return;
  const [cmd, arg] = m.text.trim().split(/\s+/);
  if (cmd !== "/start" && cmd !== "/play") {
    return tg("sendMessage", {
      chat_id: m.chat.id,
      text: "Нажми кнопку, чтобы открыть игру 👇",
      reply_markup: { inline_keyboard: [[{ text: "🃏 Играть", web_app: { url: appUrl() } }]] },
    });
  }
  const code = (arg || "").toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(code)) {
    return tg("sendMessage", {
      chat_id: m.chat.id,
      text: `Тебя зовут за стол в китайского дурака. Комната ${code}.`,
      reply_markup: { inline_keyboard: [[{ text: "🃏 Сесть за стол", web_app: { url: appUrl(code) } }]] },
    });
  }
  return tg("sendMessage", {
    chat_id: m.chat.id,
    text: "Китайский дурак by Кащей.\n\nСоздай комнату и позови друга кнопкой «Пригласить», или потренируйся с ботами.",
    reply_markup: { inline_keyboard: [[{ text: "🃏 Играть", web_app: { url: appUrl() } }]] },
  });
}

async function setupBot() {
  if (!BOT_TOKEN) return;
  const me = await tg("getMe");
  if (me) botUsername = me.username;
  if (!PUBLIC_URL) {
    console.error("Не знаю адрес сервера: задай PUBLIC_URL (на Render он подставится сам).");
    return;
  }
  await tg("setWebhook", { url: PUBLIC_URL + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ["message"] });
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: appUrl() } } });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть игру" }] });
  console.log(`Бот @${botUsername} готов, игра: ${PUBLIC_URL}`);
}

// Проверка, что игрок правда пришёл из Telegram (подпись initData)
function checkInitData(initData) {
  if (typeof initData !== "string" || !initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 7 * 86400) return null;
  let u = null;
  try { u = JSON.parse(p.get("user") || "null"); } catch (e) {}
  if (!u || !u.id) return null;
  return { id: "tg" + u.id, name: String(u.first_name || u.username || "Игрок").slice(0, 16) };
}

/* ---------------- комнаты ---------------- */
const rooms = new Map(); // code -> { st, subs:Set<ws>, timer }

function genCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s;
  do { s = ""; for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)]; } while (rooms.has(s));
  return s;
}

function newRoom(host, practice) {
  const code = genCode();
  const st = {
    code, status: "lobby", host: host.id, practice: !!practice,
    players: [{ id: host.id, name: host.name }],
    hands: {}, up: {}, down: {}, ready: {}, deck: [], pile: [], burned: 0,
    finished: [], loser: null, turn: 0, log: [], updated: Date.now(),
  };
  const room = { st, subs: new Set(), timer: null };
  rooms.set(code, room);
  return room;
}

// Что видит конкретный игрок: свою руку целиком, у остальных только количество карт.
function viewFor(st, uid) {
  const hands = {}, down = {};
  for (const p of st.players) {
    const h = st.hands[p.id] || [];
    hands[p.id] = p.id === uid ? h : h.length;
    down[p.id] = (st.down[p.id] || []).length;
  }
  return { ...st, hands, down, deck: st.deck.length };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) {
  room.st.updated = Date.now();
  for (const ws of room.subs) send(ws, { t: "state", room: viewFor(room.st, ws.user && ws.user.id) });
}

function scheduleBots(room) {
  if (room.timer) return;
  const id = R.botToAct(room.st);
  if (!id) return;
  const delay = room.st.status === "swap" ? 500 : 900 + Math.random() * 700;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (!rooms.has(room.st.code)) return;
    const res = R.A.bot(room.st, id);
    if (res !== false && typeof res !== "string") broadcast(room);
    scheduleBots(room);
  }, delay);
}

function subscribe(ws, room) {
  if (ws.room && ws.room !== room) ws.room.subs.delete(ws);
  ws.room = room;
  room.subs.add(ws);
}

const ACTIONS = new Set(["start", "leave", "swap", "ready", "play", "blind", "take", "again", "addBot", "kick"]);

function handle(ws, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "hello") {
    let user = checkInitData(msg.initData);
    if (!user && DEV && typeof msg.dev === "string") {
      user = { id: "dev" + msg.dev.replace(/[^a-z0-9]/gi, "").slice(0, 12), name: String(msg.name || "Игрок").slice(0, 16) };
    }
    if (!user) return send(ws, { t: "fatal", msg: "Открой игру через Telegram-бота, а не по прямой ссылке." });
    ws.user = user;
    return send(ws, { t: "me", me: user, bot: botUsername });
  }
  if (!ws.user) return;
  const me = ws.user;

  if (msg.t === "create" || msg.t === "practice") {
    const room = newRoom(me, msg.t === "practice");
    if (msg.t === "practice") {
      const n = Math.min(3, Math.max(1, Number(msg.bots) || 1));
      for (let i = 0; i < n; i++) room.st.players.push({ id: "bot" + i, name: R.BOT_NAMES[i], bot: true });
      R.deal(room.st);
    }
    subscribe(ws, room);
    broadcast(room);
    return scheduleBots(room);
  }
  if (msg.t === "enter") {
    const code = String(msg.code || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, { t: "gone", code });
    if (room.st.practice && room.st.host !== me.id) return send(ws, { t: "gone", code });
    subscribe(ws, room);
    if (room.st.status === "lobby") R.A.join(room.st, me.id, me.name);
    broadcast(room);
    return scheduleBots(room);
  }
  if (msg.t === "exit") {
    if (ws.room) {
      const room = ws.room;
      room.subs.delete(ws);
      ws.room = null;
      if (room.st.practice) { clearTimeout(room.timer); rooms.delete(room.st.code); }
    }
    return;
  }
  if (msg.t === "close") {
    const room = ws.room;
    if (!room || room.st.host !== me.id) return;
    for (const s of room.subs) { send(s, { t: "gone", code: room.st.code }); s.room = null; }
    clearTimeout(room.timer);
    rooms.delete(room.st.code);
    return;
  }
  if (msg.t === "act") {
    const room = ws.room;
    if (!room || !ACTIONS.has(msg.a)) return;
    const args = Array.isArray(msg.args) ? msg.args.slice(0, 3) : [];
    let res;
    try { res = R.A[msg.a](room.st, me.id, ...args); }
    catch (e) { console.error(e); res = "Что-то пошло не так, попробуй ещё раз"; }
    if (typeof res === "string") send(ws, { t: "error", msg: res });
    else if (res !== false) broadcast(room);
    if (msg.a === "leave") { room.subs.delete(ws); ws.room = null; }
    return scheduleBots(room);
  }
}

// Чистим комнаты, где давно никто не играл
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.st.updated;
    if (idle > 6 * 3600e3 || (room.subs.size === 0 && idle > 30 * 60e3)) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 10 * 60e3);

/* ---------------- HTTP ---------------- */
const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === HOOK_PATH) {
    if (req.headers["x-telegram-bot-api-secret-token"] !== HOOK_SECRET) { res.writeHead(403); return res.end(); }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      res.writeHead(200); res.end("ok");
      let u; try { u = JSON.parse(body); } catch (e) { return; }
      onUpdate(u).catch(e => console.error(e));
    });
    return;
  }
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end(DEV ? indexHtml.toString().replace("window.__DEV__=false", "window.__DEV__=true") : indexHtml);
  }
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", data => {
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on("close", () => { if (ws.room) ws.room.subs.delete(ws); });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}${DEV ? " (режим DEV)" : ""}`);
  setupBot().catch(e => console.error("Не удалось настроить бота:", e));
});
