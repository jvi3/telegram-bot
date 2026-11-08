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
const ADMIN_IDS = String(process.env.ADMIN_IDS || "").split(/[^0-9]+/).filter(Boolean);
const startedAt = Date.now();

/* ---------------- данные: игроки, рейтинг, баны, статистика ---------------- */
// Если задан DATABASE_URL (бесплатная база Neon), всё хранится там навсегда.
// Без базы данные лежат в файле data.json и стираются при перезапуске сервера на Render.
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
let data = { users: {}, banned: [], stats: { games: 0 }, maintenance: false };
let pool = null;

async function loadData() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, max: 3, idleTimeoutMillis: 30000 });
    pool.on("error", e => console.error("База данных:", e.message)); // Neon сам закрывает простаивающие соединения
    await pool.query("CREATE TABLE IF NOT EXISTS durak_kv (k text PRIMARY KEY, v jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())");
    const r = await pool.query("SELECT v FROM durak_kv WHERE k = 'data'");
    if (r.rows[0]) data = Object.assign(data, r.rows[0].v);
    console.log(`База данных подключена: игроков ${Object.keys(data.users).length}, партий ${data.stats.games}`);
    return;
  }
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
  console.log("База данных не подключена: данные хранятся до перезапуска сервера (добавь DATABASE_URL).");
}

let saveTimer = null, saving = Promise.resolve();
async function writeNow() {
  const json = JSON.stringify(data);
  if (pool) {
    try { await pool.query("INSERT INTO durak_kv (k, v, updated) VALUES ('data', $1::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()", [json]); }
    catch (e) { console.error("Не удалось сохранить в базу:", e.message); }
  } else {
    await fs.promises.writeFile(DATA_FILE, json).catch(e => console.error("Не удалось сохранить data.json:", e.message));
  }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(writeNow); }, 1500);
}
// Render выключает сервер сигналом SIGTERM (засыпание, новая версия): успеваем сохранить
async function flushAndExit() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saving = saving.then(writeNow); }
  await saving;
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", flushAndExit);
process.on("SIGINT", flushAndExit);

function boardRows() {
  return Object.entries(data.users)
    .filter(([id, u]) => (u.games || 0) > 0 && !data.banned.includes(id))
    .map(([id, u]) => ({ id: "tg" + id, name: u.name || "Игрок", points: u.points || 0, wins: u.wins || 0, fools: u.fools || 0, games: u.games || 0 }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.fools - b.fools || b.games - a.games)
    .slice(0, 20);
}
function touchUser(tgId, from) {
  const id = String(tgId);
  const u = data.users[id] || { first: Date.now(), games: 0 };
  if (from) { u.name = String(from.first_name || from.username || u.name || "Игрок").slice(0, 32); if (from.username) u.username = from.username; }
  u.last = Date.now();
  data.users[id] = u;
  save();
}

/* ---------------- Telegram API ---------------- */
async function tg(method, body, opts) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok && !(opts && opts.quiet)) console.error(`Telegram ${method}:`, j.description || res.status);
  return j.result;
}

const appUrl = code => PUBLIC_URL + "/" + (code ? `?room=${code}` : "");

async function onUpdate(u) {
  if (u.callback_query) return admin.onCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.text || !m.chat) return;
  if (m.from && m.chat.type === "private") touchUser(m.from.id, m.from);
  if (await admin.onMessage(m)) return;
  const [cmd, arg] = m.text.trim().split(/\s+/);
  if (cmd === "/myid") {
    return tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", text: `Твой Telegram ID: <code>${m.from.id}</code>${admin.isAdmin(m.from.id) ? "\nТы админ, панель: /admin" : ""}` });
  }
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
  await tg("setWebhook", { url: PUBLIC_URL + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ["message", "callback_query"] });
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: appUrl() } } });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть игру" }, { command: "myid", description: "Узнать свой ID" }] });
  for (const id of ADMIN_IDS) {
    await tg("setMyCommands", { scope: { type: "chat", chat_id: Number(id) }, commands: [
      { command: "start", description: "Открыть игру" }, { command: "admin", description: "Админ-панель" }, { command: "myid", description: "Узнать свой ID" },
    ] }, { quiet: true });
  }
  if (!ADMIN_IDS.length) console.log("Админов нет: добавь ADMIN_IDS в Environment Variables, чтобы открыть /admin.");
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
  return { id: "tg" + u.id, name: String(u.first_name || u.username || "Игрок").slice(0, 16), from: { first_name: u.first_name, username: u.username } };
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
  if (room.lastStatus !== room.st.status) {
    if (room.st.status === "over" && !room.st.practice) {
      data.stats.games++;
      const n = room.st.players.length;
      for (const p of room.st.players) {
        const id = p.id.startsWith("tg") ? p.id.slice(2) : null;
        const u = id && data.users[id];
        if (!u) continue;
        u.games = (u.games || 0) + 1;
        if (p.id === room.st.loser) u.fools = (u.fools || 0) + 1;
        else {
          const place = room.st.finished.indexOf(p.id);
          u.points = (u.points || 0) + Math.max(0, n - 1 - place); // вышел первым — больше всех очков, дурак — 0
          if (place === 0) u.wins = (u.wins || 0) + 1;
        }
      }
      save();
      const board = boardRows();
      for (const ws of wss.clients) if (ws.user) send(ws, { t: "board", rows: board });
    }
    room.lastStatus = room.st.status;
  }
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
      const nm = String(msg.name || "Игрок").slice(0, 16);
      user = { id: "tg" + parseInt(sha(msg.dev).slice(0, 10), 16), name: nm, from: { first_name: nm } };
    }
    if (!user) return send(ws, { t: "fatal", msg: "Открой игру через Telegram-бота, а не по прямой ссылке." });
    const tgId = user.id.startsWith("tg") ? user.id.slice(2) : null;
    if (tgId && data.banned.includes(tgId)) return send(ws, { t: "fatal", msg: "Тебе закрыт доступ к игре." });
    if (tgId) touchUser(tgId, user.from);
    ws.user = user;
    send(ws, { t: "board", rows: boardRows() });
    return send(ws, { t: "me", me: { id: user.id, name: user.name }, bot: botUsername });
  }
  if (!ws.user) return;
  const me = ws.user;

  const MAINT = "Идут техработы, новые игры пока не создаются. Загляни чуть позже.";
  if (msg.t === "create" || msg.t === "practice") {
    if (data.maintenance && !admin.isAdmin(me.id.replace(/^tg/, ""))) return send(ws, { t: "error", msg: MAINT });
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
    closeRoom(room.st.code);
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

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return false;
  for (const s of room.subs) { send(s, { t: "gone", code }); s.room = null; }
  clearTimeout(room.timer);
  rooms.delete(code);
  return true;
}
function kickUser(tgId) {
  for (const ws of wss.clients) {
    if (ws.user && ws.user.id === "tg" + tgId) { send(ws, { t: "fatal", msg: "Тебе закрыт доступ к игре." }); ws.close(); }
  }
}
function onlineIds() {
  const s = new Set();
  for (const ws of wss.clients) if (ws.user && ws.user.id.startsWith("tg")) s.add(ws.user.id.slice(2));
  return s;
}
const admin = require("./admin")({ tg, rooms, data, save, adminIds: ADMIN_IDS, kickUser, closeRoom, onlineIds, startedAt, appUrl });

// Чистим комнаты, где давно никто не играл
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.st.updated;
    if (idle > 6 * 3600e3 || (room.subs.size === 0 && idle > 30 * 60e3)) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 10 * 60e3);

/* ---------------- HTTP ---------------- */
const indexPath = [path.join(__dirname, "index.html"), path.join(__dirname, "public", "index.html")].find(p => fs.existsSync(p));
if (!indexPath) {
  console.error("Не нашёл index.html. Загрузи его на GitHub рядом с server.js.");
  process.exit(1);
}
const indexHtml = fs.readFileSync(indexPath);

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

loadData()
  .catch(e => { pool = null; console.error("Не удалось загрузить данные из базы, работаю без неё (данные в базе не трогаю):", e.message); })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}${DEV ? " (режим DEV)" : ""}`);
      setupBot().catch(e => console.error("Не удалось настроить бота:", e));
    });
  });
