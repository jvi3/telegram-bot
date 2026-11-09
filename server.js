// Китайский дурак для Telegram (by Кащей): сервер игры + бот.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const R = require("./rules");
const SHOP = require("./shop");
const createCasino = require("./casino");

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
let data = { users: {}, banned: [], stats: { games: 0 }, maintenance: false, promos: {} };
let pool = null;

// Аватарки хранятся отдельно от общих данных: tgId -> { buf, v }
const avatars = new Map();
const AV_FILE = DATA_FILE + ".avatars.json";
async function loadAvatars() {
  if (pool) {
    const r = await pool.query("SELECT k, v FROM durak_kv WHERE k LIKE 'av:%'");
    for (const row of r.rows) if (row.v && row.v.d) avatars.set(row.k.slice(3), { buf: Buffer.from(row.v.d, "base64"), v: row.v.v });
  } else {
    try { const j = JSON.parse(fs.readFileSync(AV_FILE, "utf8")); for (const [id, a] of Object.entries(j)) avatars.set(id, { buf: Buffer.from(a.d, "base64"), v: a.v }); } catch (e) {}
  }
}
async function saveAvatar(id) {
  const a = avatars.get(id);
  if (pool) {
    try {
      if (a) await pool.query("INSERT INTO durak_kv (k, v, updated) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()", ["av:" + id, JSON.stringify({ d: a.buf.toString("base64"), v: a.v })]);
      else await pool.query("DELETE FROM durak_kv WHERE k = $1", ["av:" + id]);
    } catch (e) { console.error("Не удалось сохранить аватарку:", e.message); }
  } else {
    const j = {}; for (const [k, x] of avatars) j[k] = { d: x.buf.toString("base64"), v: x.v };
    fs.promises.writeFile(AV_FILE, JSON.stringify(j)).catch(() => {});
  }
}
const avatarUrl = id => { const a = avatars.get(String(id)); return a ? `/av/${id}?v=${a.v}` : ""; };
const displayName = (u, fallback) => (u && u.nick) || (u && u.name) || fallback || "Игрок";
function cleanNick(n) {
  n = String(n || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  if (n.length < 2 || n.length > 16) return null;
  return n;
}

async function loadData() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, max: 3, idleTimeoutMillis: 30000 });
    pool.on("error", e => console.error("База данных:", e.message)); // Neon сам закрывает простаивающие соединения
    await pool.query("CREATE TABLE IF NOT EXISTS durak_kv (k text PRIMARY KEY, v jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())");
    const r = await pool.query("SELECT v FROM durak_kv WHERE k = 'data'");
    if (r.rows[0]) data = Object.assign(data, r.rows[0].v);
    await loadAvatars();
    console.log(`База данных подключена: игроков ${Object.keys(data.users).length}, партий ${data.stats.games}, аватарок ${avatars.size}`);
    return;
  }
  try { data = Object.assign(data, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
  await loadAvatars();
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
    .map(([id, u]) => ({ id: "tg" + id, name: displayName(u), avatar: avatarUrl(id), points: u.points || 0, wins: u.wins || 0, fools: u.fools || 0, games: u.games || 0, coins: SHOP.ensureEco(u).coins, title: (SHOP.BY_ID[u.equipped.title] || {}).key || "" }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.fools - b.fools || b.games - a.games)
    .slice(0, 20);
}
function touchUser(tgId, from) {
  const id = String(tgId);
  const u = data.users[id] || { first: Date.now(), games: 0 };
  if (from) { u.name = String(from.first_name || from.username || u.name || "Игрок").slice(0, 32); if (from.username) u.username = from.username; }
  u.last = Date.now();
  SHOP.ensureEco(u);
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
      { command: "give", description: "Выдать деньги: /give ID сумма" }, { command: "promo", description: "Промокод: /promo КОД СУММА ЛИМИТ" },
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
    finished: [], loser: null, turn: 0, log: [], updated: Date.now(), waitSince: Date.now(), open: false,
  };
  const room = { st, subs: new Set(), timer: null };
  rooms.set(code, room);
  return room;
}

// Что видит конкретный игрок: свою руку целиком, у остальных только количество карт.
// Цвет и титул каждого игрока: свой цвет, если он не занят тем, кто сел раньше
function userOf(pid) { return pid && pid.startsWith("tg") ? data.users[pid.slice(2)] : null; }
function decorate(st) {
  const used = new Set();
  return st.players.map(p => {
    const u = userOf(p.id);
    let color = u ? (SHOP.BY_ID[SHOP.ensureEco(u).equipped.color] || {}).key : null;
    if (!color || used.has(color)) color = SHOP.COLOR_ORDER.find(c => !used.has(c)) || "#f2c14e";
    used.add(color);
    const title = u ? (SHOP.BY_ID[u.equipped.title] || {}).key || "" : "";
    return { ...p, color, title, avatar: u ? avatarUrl(p.id.slice(2)) : "" };
  });
}
/* ---------- друзья ---------- */
function friendCode(tgId) {
  const u = data.users[tgId]; if (!u) return null;
  if (!u.fcode) { const used = new Set(Object.values(data.users).map(x => x.fcode).filter(Boolean)); let c; do { c = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase(); } while (used.has(c)); u.fcode = c; save(); }
  return u.fcode;
}
function friendStatus(fid) {
  const ws = wsOf(fid); if (!ws.length) return { status: "offline" };
  const inRoom = ws.find(w => w.room && w.room.st.status !== "lobby" && w.room.st.status !== "over");
  return { status: inRoom ? "game" : "online" };
}
function friendList(tgId) {
  const u = data.users[tgId]; if (!u) return [];
  return (u.friends || []).filter(id => data.users[id]).map(id => ({ id, name: displayName(data.users[id]), avatar: avatarUrl(id), ...friendStatus(id), last: data.users[id].last || 0, unread: (u.unread || {})[id] || 0 }))
    .sort((a, b) => ({ online: 0, game: 1, offline: 2 }[a.status] - { online: 0, game: 1, offline: 2 }[b.status]) || b.last - a.last);
}
// когда друг зашёл или вышел — обновляем список у тех, кто сейчас в игре
const notifyT = new Map();
function notifyFriends(tgId) {
  clearTimeout(notifyT.get(tgId));
  notifyT.set(tgId, setTimeout(() => { notifyT.delete(tgId); const u = data.users[tgId]; if (!u) return; for (const f of u.friends || []) if (wsOf(f).length) sendFriends(f); }, 1500));
}
/* ---------- личные сообщения между друзьями ---------- */
const dmKey = (a, b) => [String(a), String(b)].sort().join("_");
const dmBotT = new Map();
function sendFriends(tgId) { const list = friendList(tgId), code = friendCode(tgId); for (const w of wsOf(tgId)) send(w, { t: "friends", list, code }); }
function makeFriends(a, b) {
  const ua = data.users[a], ub = data.users[b]; if (!ua || !ub || a === b) return "Нельзя";
  ua.friends = ua.friends || []; ub.friends = ub.friends || [];
  if (ua.friends.includes(b)) return "Вы уже друзья";
  if (ua.friends.length >= 100) return "Друзей уже 100 — это максимум";
  ua.friends.push(b); if (!ub.friends.includes(a)) ub.friends.push(a); save();
  sendFriends(a); sendFriends(b);
  for (const w of wsOf(b)) send(w, { t: "toast", msg: `${displayName(ua)} добавил тебя в друзья 🤝` });
  return null;
}
function wsOf(tgId) { return [...wss.clients].filter(ws => ws.user && ws.user.id === "tg" + tgId); }
function profileCoins(tgId) { const u = data.users[tgId]; return u ? u.coins : null; }
function fullProfile(tgId) {
  const u = data.users[tgId];
  return { ...SHOP.profile(u), nick: u.nick || "", tgName: u.name || "", avatar: avatarUrl(tgId), ...(admin.isAdmin(tgId) ? { admin: true, rig: !!(data.rig && data.rig[tgId]), demoOnline: !!(data.demoOnline && data.demoOnline[tgId]) } : {}) };
}
function sendProfile(tgId) {
  const u = data.users[tgId];
  if (!u) return;
  const prof = fullProfile(tgId);
  for (const ws of wsOf(tgId)) send(ws, { t: "profile", ...prof });
}
function giveCoins(tgId, amount, reason) {
  const u = data.users[tgId];
  if (!u) return null;
  SHOP.ensureEco(u);
  const before = u.coins;
  u.coins = Math.max(0, u.coins + amount);
  const delta = u.coins - before;
  save();
  for (const ws of wsOf(tgId)) send(ws, { t: "reward", delta, coins: u.coins, reason });
  sendProfile(tgId);
  return delta;
}
function rewardGame(st) {
  const humans = st.players.filter(p => userOf(p.id));
  const E = SHOP.ECONOMY;
  if (st.practice) {
    const p = humans[0];
    if (!p || st.finished[0] !== p.id) return;
    const u = userOf(p.id), day = SHOP.today();
    if (u.practiceDay !== day) { u.practiceDay = day; u.practiceCount = 0; }
    if (u.practiceCount >= E.practiceCap) return;
    u.practiceCount++;
    giveCoins(p.id.slice(2), E.practiceWin, `Победа в тренировке (${u.practiceCount}/${E.practiceCap} сегодня)`);
    return;
  }
  if (humans.length < 2) return;
  const w = humans.find(p => st.finished[0] === p.id), fool = st.players.find(p => p.id === st.loser);
  if (w) pushFeed({ kind: "game", name: feedName(w.id.slice(2)), avatar: avatarUrl(w.id.slice(2)), vs: fool ? fool.name : "", win: SHOP.ECONOMY.win });
  for (const p of humans) {
    const place = st.finished.indexOf(p.id);
    if (p.id === st.loser) giveCoins(p.id.slice(2), E.fool, "Ты дурак");
    else if (place === 0) giveCoins(p.id.slice(2), E.win, "Победа!");
    else giveCoins(p.id.slice(2), E.middle, "Не дурак");
  }
}

/* ---------- режимы стола: блиц, матч до 3 побед, дуэль на ставку ---------- */
const MODES = ["normal", "blitz", "match", "stake"];
function setMode(st, mode, amount) {
  st.mode = MODES.includes(mode) ? mode : "normal";
  st.timer = st.mode === "blitz" ? 5 : (st.timer === 5 ? 0 : st.timer || 0);
  st.stake = st.mode === "stake" ? Math.max(5, Math.min(100000, Math.floor(Number(amount) || 25))) : 0;
  st.match = st.mode === "match" ? { to: 3, score: {} } : null;
  st.champion = null; st.pot = 0; st.raise = null; st.raises = 0; st.potWon = null;
}
// перед раздачей в игре на ставку забираем деньги в банк
function collectStake(room) {
  const st = room.st; if (st.mode !== "stake") return null;
  if (st.players.length < 2) return "Нужно хотя бы 2 игрока";
  if (st.players.some(p => p.bot)) return "В игре на ставку только люди — убери ботов";
  const poor = st.players.find(p => (userOf(p.id) || { coins: 0 }).coins < st.stake);
  if (poor) return `${poor.name}: не хватает денег на ставку $${st.stake}`;
  for (const p of st.players) giveCoins(p.id.slice(2), -st.stake, `Ставка в банк`);
  st.pot = st.stake * st.players.length; st.raise = null; st.raises = 0; st.potWon = null;
  return null;
}
function settleModes(st) {
  const w = st.finished[0];
  if (st.mode === "stake" && st.pot) {
    if (w && userOf(w)) { giveCoins(w.slice(2), st.pot, `Банк дуэли`); st.potWon = { pid: w, amount: st.pot }; if (st.pot >= 100) pushFeed({ kind: "casino", name: feedName(w.slice(2)), avatar: avatarUrl(w.slice(2)), game: "дуэли на ставку", win: st.pot, mult: st.players.length }); }
    st.pot = 0; st.raise = null;
  }
  if (st.mode === "match" && st.match && w) {
    if (st.champion) st.match.score = {}, st.champion = null;
    st.match.score[w] = (st.match.score[w] || 0) + 1;
    if (st.match.score[w] >= st.match.to) st.champion = w;
  }
}
// Таймер хода (если создатель комнаты включил): не успел — за тебя ходит бот
function armTimer(room) {
  const st = room.st;
  clearTimeout(room.turnT);
  room.turnT = null;
  st.deadline = null;
  if (!st.timer) return;
  if (st.status === "play") {
    const cur = st.players[st.turn];
    if (!cur || cur.bot) return;
    st.deadline = Date.now() + st.timer * 1000;
    room.turnT = setTimeout(() => {
      if (!rooms.has(st.code) || st.status !== "play" || st.players[st.turn].id !== cur.id) return;
      if (st.mode === "blitz" && st.pile.length) { R.A.take(st, cur.id); st.log = [`⏰ ${cur.name} не успел — забирает стопку`, ...(st.log || [])].slice(0, 8); }
      else { R.A.bot(st, cur.id); st.log = [`⏰ ${cur.name} не успел — за него сходил бот`, ...(st.log || [])].slice(0, 8); }
      broadcast(room);
      scheduleBots(room);
    }, st.timer * 1000);
  } else if (st.status === "swap") {
    st.deadline = Date.now() + 45000;
    room.turnT = setTimeout(() => {
      if (!rooms.has(st.code) || st.status !== "swap") return;
      for (const p of st.players) if (!st.ready[p.id]) R.A.ready(st, p.id);
      broadcast(room);
      scheduleBots(room);
    }, 45000);
  }
}

function viewFor(st, uid) {
  const hands = {}, down = {};
  for (const p of st.players) {
    const h = st.hands[p.id] || [];
    hands[p.id] = p.id === uid ? h : h.length;
    down[p.id] = (st.down[p.id] || []).length;
  }
  // Неподошедшую закрытую карту видит только тот, кто её открыл: она ушла ему в руку
  const lb = st.lastBlind && !st.lastBlind.ok && st.lastBlind.pid !== uid ? { ...st.lastBlind, card: null } : st.lastBlind;
  return { ...st, lastBlind: lb, players: decorate(st), hands, down, deck: st.deck.length, pileBy: st.pileBy || [],
    turnLeft: st.deadline ? Math.max(0, st.deadline - Date.now()) : 0,
    countLeft: st.countdownAt ? Math.max(0, st.countdownAt - Date.now()) : 0,
    waitedMs: st.waitSince ? Date.now() - st.waitSince : 0,
    online: [...new Set([...(rooms.get(st.code) || { subs: [] }).subs].map(w => w.user && w.user.id).filter(Boolean))] };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
/* ---------- лайв-лента: большие выигрыши и победы ---------- */
function pushFeed(ev) {
  data.feed = [{ ...ev, ts: Date.now() }, ...(data.feed || [])].slice(0, 30);
  save();
  for (const w of wss.clients) if (w.user) send(w, { t: "feed", items: data.feed.slice(0, 12) });
}
function feedName(tgId) { const u = data.users[tgId]; return displayName(u); }

/* ---------- реванш и автостарт ---------- */
const subIds = room => new Set([...room.subs].map(w => w.user && w.user.id).filter(Boolean));
function startDeal(room) {
  const st = room.st;
  const keep = st.rematch ? st.players.filter(p => p.bot || st.rematch[p.id]) : st.players;
  if (keep.length < 2) { // не набралось — назад в ожидание
    st.players = keep; st.rematch = null; st.countdownAt = null; st.status = "lobby"; st.waitSince = Date.now();
    if (!st.players.some(p => p.id === st.host)) { const h = st.players.find(p => !p.bot); if (h) st.host = h.id; }
  } else {
    const err = collectStake(room);
    if (err) { st.status = "lobby"; st.rematch = null; st.waitSince = Date.now(); for (const w of room.subs) send(w, { t: "error", msg: err }); }
    else R.deal(st);
  }
  broadcast(room); scheduleBots(room); sendOpenTables();
}
function cancelCountdown(room) { if (room.cdT) { clearTimeout(room.cdT); room.cdT = null; } room.st.countdownAt = null; }
function checkCountdown(room) {
  const st = room.st;
  let want = 0;
  if (st.status === "over") {
    const online = subIds(room);
    const voters = st.players.filter(p => !p.bot && online.has(p.id));
    st.rematch = st.rematch || {};
    for (const p of st.players) if (p.bot) st.rematch[p.id] = true;
    const yes = st.players.filter(p => p.bot || st.rematch[p.id]);
    if (voters.length && voters.every(p => st.rematch[p.id]) && yes.some(p => !p.bot)) want = st.practice ? 1200 : 10000;
  } else if (st.status === "lobby" && st.open && st.players.length >= 2) want = 30000;
  if (!want) { if (room.cdT) cancelCountdown(room); return; }
  if (room.cdT) return;
  st.countdownAt = Date.now() + want;
  room.cdT = setTimeout(() => { room.cdT = null; st.countdownAt = null; if (rooms.has(st.code)) startDeal(room); }, want);
}
// список открытых столов для тех, кто в меню
function openList() {
  return [...rooms.values()].filter(r => r.st.open && r.st.status === "lobby" && !r.st.practice && r.st.players.length < 5)
    .map(r => ({ code: r.st.code, n: r.st.players.length, names: r.st.players.map(p => p.name).slice(0, 5), avatars: decorate(r.st).map(p => p.avatar || ""), since: r.st.waitSince }))
    .sort((a, b) => b.n - a.n || a.since - b.since).slice(0, 15);
}
/* ---------- общий онлайн: кто в игре, лобби (закрытые — с замочком) и идущие партии ---------- */
function onlineSnapshot() {
  const users = new Map(); // tgId -> where
  for (const w of wss.clients) { if (!w.user || !w.user.id.startsWith("tg")) continue; const id = w.user.id.slice(2), r = w.room;
    const where = !r ? "menu" : r.st.practice ? "practice" : r.st.status === "lobby" ? "lobby" : "game";
    const rank = { game: 3, practice: 2, lobby: 1, menu: 0 }; if (!users.has(id) || rank[where] > rank[users.get(id)]) users.set(id, where); }
  const c = { total: users.size, menu: 0, lobby: 0, game: 0, practice: 0 }; for (const v of users.values()) c[v]++;
  const all = [...rooms.values()];
  const lobbies = all.filter(r => !r.st.practice && r.st.status === "lobby" && r.st.players.length).map(r => { const d = decorate(r.st), host = d.find(p => p.id === r.st.host) || d[0];
    return { code: r.st.open ? r.st.code : null, open: !!r.st.open, host: host ? host.name : "", avatar: host ? host.avatar || "" : "", n: r.st.players.length, names: d.map(p => p.name), avatars: d.map(p => p.avatar || ""), mode: r.st.mode || "normal", stake: r.st.stake || 0, since: r.st.waitSince || Date.now() }; })
    .sort((a, b) => (b.open - a.open) || a.since - b.since).slice(0, 30);
  const games = all.filter(r => !r.st.practice && r.st.status !== "lobby").map(r => ({ names: r.st.players.map(p => p.name), mode: r.st.mode || "normal", pot: r.st.pot || 0, status: r.st.status })).slice(0, 30);
  return { counts: c, lobbies, games, practice: all.filter(r => r.st.practice).length, peak: data.peak || null };
}
// Демо-онлайн: выдуманные игроки и столы видит только админ, который это включил (чтобы посмотреть, как выглядит людный онлайн)
const DEMO_NAMES = ["Лёха", "Марина", "Тёма", "Ксюша", "Гоша", "Влад", "Настя", "Дима", "Саня", "Полина", "Рома", "Катя", "Миша", "Оля", "Женя", "Вика"];
function demoAdd(snap) {
  const t = Math.floor(Date.now() / 60000), pick = (i) => DEMO_NAMES[(i * 7 + t) % DEMO_NAMES.length];
  const modes = ["normal", "blitz", "stake", "match", "normal"];
  const lob = [0, 1, 2, 3, 4].map(i => { const n = 1 + ((i + t) % 3); return { code: null, open: i % 3 !== 2, demo: true, host: pick(i * 3), avatar: "", n, names: Array.from({ length: n }, (_, k) => pick(i * 3 + k)), avatars: [], mode: modes[i], stake: modes[i] === "stake" ? [25, 50, 100][i % 3] : 0, since: Date.now() - (i * 47 + 20) * 1000 }; });
  const games = [0, 1, 2, 3].map(i => ({ names: [pick(i * 5 + 1), pick(i * 5 + 2), ...(i % 2 ? [pick(i * 5 + 3)] : [])], mode: modes[(i + 1) % 5], pot: modes[(i + 1) % 5] === "stake" ? 150 + i * 50 : 0, status: "play", demo: true }));
  const add = { menu: 9, lobby: lob.reduce((a, l) => a + l.n, 0), game: games.reduce((a, g) => a + g.names.length, 0), practice: 4 };
  const c = { ...snap.counts }; for (const k in add) c[k] += add[k]; c.total = c.menu + c.lobby + c.game + c.practice;
  return { ...snap, counts: c, lobbies: [...snap.lobbies, ...lob], games: [...snap.games, ...games], practice: snap.practice + 4, demo: true };
}
const demoOn = tgId => !!(tgId && admin.isAdmin(tgId) && data.demoOnline && data.demoOnline[tgId]);
function notePeak() { const day = SHOP.today(), n = onlineIds().size; if (!data.peak || data.peak.day !== day) data.peak = { day, n, at: Date.now() }; else if (n > data.peak.n) { data.peak.n = n; data.peak.at = Date.now(); } }
let onlineT = null;
function sendOnline(ws) {
  const tgOf = w => w.user && w.user.id.startsWith("tg") ? w.user.id.slice(2) : null;
  const out = (w, snap) => send(w, { t: "online", ...(demoOn(tgOf(w)) ? demoAdd(snap) : snap) });
  if (ws) return out(ws, onlineSnapshot());
  if (onlineT) return; onlineT = setTimeout(() => { onlineT = null; let snap = null; for (const w of wss.clients) if (w.watchOnline) out(w, snap = snap || onlineSnapshot()); }, 400);
}
setInterval(() => { notePeak(); sendOnline(); }, 10000);
let openT = null;
function sendOpenTables(ws) {
  if (ws) return send(ws, { t: "openTables", list: openList() });
  sendOnline();
  if (openT) return; openT = setTimeout(() => { openT = null; const list = openList(); for (const w of wss.clients) if (w.user && !w.room) send(w, { t: "openTables", list }); }, 300);
}
setInterval(() => sendOpenTables(), 15000);

function broadcast(room) {
  room.st.updated = Date.now(); sendOnline();
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
    if (room.st.status === "over") { rewardGame(room.st); settleModes(room.st); room.st.rematch = {}; }
    room.lastStatus = room.st.status;
  }
  armTimer(room);
  checkCountdown(room);
  if (room.st.open || room.lastOpen) { room.lastOpen = room.st.open; sendOpenTables(); }
  for (const ws of room.subs) send(ws, { t: "state", room: viewFor(room.st, ws.user && ws.user.id) });
}

function scheduleBots(room) {
  if (room.timer) return;
  const id = R.botToAct(room.st);
  if (!id) return;
  const delay = room.st.status === "swap" ? 600 : 1300 + Math.random() * 700;
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

const ACTIONS = new Set(["start", "leave", "swap", "arrange", "ready", "play", "blind", "take", "again", "vote", "setOpen", "addBot", "kick", "setTimer"]);

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
    if (tgId) { touchUser(tgId, user.from); user.name = displayName(data.users[tgId], user.name).slice(0, 16); }
    ws.user = user;
    send(ws, { t: "board", rows: boardRows() });
    send(ws, { t: "catalog", items: SHOP.ITEMS, eco: SHOP.ECONOMY, casino: { roul: casino.ROUL, classic: casino.PAY3, machines: casino.MACHINES } });
    if (tgId && data.users[tgId]) send(ws, { t: "profile", ...fullProfile(tgId) });
    sendOpenTables(ws);
    send(ws, { t: "feed", items: (data.feed || []).slice(0, 12) });
    return send(ws, { t: "me", me: { id: user.id, name: user.name }, bot: botUsername });
  }
  if (!ws.user) return;
  const me = ws.user;

  const MAINT = "Идут техработы, новые игры пока не создаются. Загляни чуть позже.";
  if (msg.t === "create" || msg.t === "practice") {
    if (data.maintenance && !admin.isAdmin(me.id.replace(/^tg/, ""))) return send(ws, { t: "error", msg: MAINT });
    const room = newRoom(me, msg.t === "practice");
    if (msg.t === "create" && msg.mode) setMode(room.st, String(msg.mode), msg.amount);
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
  const myTg = me.id.startsWith("tg") ? me.id.slice(2) : null;
  const myU = myTg && data.users[myTg];
  if (msg.t === "buy" || msg.t === "equip" || msg.t === "daily") {
    if (!myU) return send(ws, { t: "error", msg: "Магазин работает только в Telegram" });
    const err = msg.t === "buy" ? SHOP.buy(myU, String(msg.id)) : msg.t === "equip" ? SHOP.equip(myU, String(msg.id)) : SHOP.claimDaily(myU);
    if (err) return send(ws, { t: "error", msg: err });
    save();
    if (msg.t === "daily") { for (const s of wsOf(myTg)) send(s, { t: "reward", delta: SHOP.ECONOMY.daily, coins: myU.coins, reason: "Ежедневный бонус" }); }
    else { const it = SHOP.BY_ID[String(msg.id)]; send(ws, { t: "toast", msg: msg.t === "buy" ? (it.type === "reacts" ? `Куплено: ${it.name}` : `Куплено и установлено: ${it.name}`) : `Установлено: ${it.name}` }); }
    sendProfile(myTg);
    if (ws.room) broadcast(ws.room); // чтобы соседи по столу увидели новый цвет или титул
    return;
  }
  if (msg.t === "setProfile") {
    if (!myU) return send(ws, { t: "error", msg: "Профиль работает только в Telegram" });
    const nick = cleanNick(msg.nick);
    if (!nick) return send(ws, { t: "error", msg: "Ник — от 2 до 16 символов" });
    if (typeof msg.avatar === "string") {
      if (msg.avatar === "") avatars.delete(myTg);
      else {
        const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(msg.avatar);
        if (!m) return send(ws, { t: "error", msg: "Не получилось прочитать картинку, попробуй другую" });
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > 60000) return send(ws, { t: "error", msg: "Картинка слишком большая" });
        avatars.set(myTg, { buf, v: crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8) });
      }
      saveAvatar(myTg);
    }
    myU.nick = nick;
    save();
    for (const s of wsOf(myTg)) if (s.user) s.user.name = nick;
    for (const room of rooms.values()) {
      const p = room.st.players.find(p => p.id === me.id);
      if (p) { p.name = nick; broadcast(room); }
    }
    sendProfile(myTg);
    send(ws, { t: "toast", msg: "Профиль сохранён" });
    return;
  }
  if (msg.t === "demoOnline") { // выдуманный онлайн, виден только этому админу
    if (!myU || !admin.isAdmin(myTg)) return;
    data.demoOnline = data.demoOnline || {}; data.demoOnline[myTg] = msg.on === undefined ? !data.demoOnline[myTg] : !!msg.on; save();
    sendProfile(myTg); sendOnline(ws);
    return send(ws, { t: "toast", msg: data.demoOnline[myTg] ? "👥 Демо-онлайн включён — его видишь только ты" : "Демо-онлайн выключен" });
  }
  if (msg.t === "rig") { // подкрутка казино для теста — только админ
    if (!myU || !admin.isAdmin(myTg)) return;
    data.rig = data.rig || {}; data.rig[myTg] = msg.on === undefined ? !data.rig[myTg] : !!msg.on; save();
    sendProfile(myTg);
    return send(ws, { t: "toast", msg: data.rig[myTg] ? "🔧 Подкрутка включена: всё выпадает по максимуму, деньги не меняются" : "Подкрутка выключена" });
  }
  if (msg.t === "casino") {
    if (!myU) return send(ws, { t: "error", msg: "Казино работает только в Telegram" });
    const now = Date.now();
    if (now - (ws.lastBet || 0) < 200) return send(ws, { t: "error", msg: "Не так быстро" });
    ws.lastBet = now;
    let r;
    const rig = admin.isAdmin(myTg) && !!(data.rig && data.rig[myTg]);
    try { r = casino.play(myTg, msg, { rig }); } catch (e) { console.error(e); r = { err: "Что-то пошло не так" }; }
    if (r.err) return send(ws, { t: "error", msg: r.err });
    { const bet = r.paid || r.bet || r.stake || 0, win = r.win || 0, mult = bet ? win / bet : (r.mult || (r.prizes ? r.prizes[r.i] : 0));
      const NM = { slots: "Кащей Слотс", lucky: "Лаки 7", chest: "Сундук Кащея", roulette: "Рулетке", hilo: "Выше/ниже", xmult: "Бурмалде" };
      if (!r.rigged && win > bet && (mult >= 10 || win >= 100)) setTimeout(() => pushFeed({ kind: "casino", name: feedName(myTg), avatar: avatarUrl(myTg), game: NM[r.game] || r.game, win, mult: Math.round(mult * 10) / 10 }), 3500); }
    if (profileCoins(myTg) !== null) for (const s of wsOf(myTg)) if (s !== ws) send(s, { t: "profile", ...fullProfile(myTg) });
    return send(ws, { t: "casinoRes", ...r });
  }
  if (msg.t === "promo") {
    if (!myU) return send(ws, { t: "error", msg: "Промокоды работают только в Telegram" });
    const now = Date.now();
    if (now - (ws.lastPromo || 0) < 1500) return send(ws, { t: "error", msg: "Не так быстро" });
    ws.lastPromo = now;
    const r = SHOP.redeemPromo(data, myTg, msg.code);
    if (r.err) return send(ws, { t: "error", msg: r.err });
    giveCoins(myTg, r.amount, `Промокод ${r.code}`);
    return;
  }
  if (msg.t === "online") { ws.watchOnline = !!msg.watch; if (ws.watchOnline) sendOnline(ws); return; }
  if (msg.t === "friends") { if (myU) { sendFriends(myTg); if (!ws.seenOnline) { ws.seenOnline = true; notifyFriends(myTg); } } return; }
  if (msg.t === "dmHistory") {
    const fid = String(msg.with || ""); if (!myU || !(myU.friends || []).includes(fid)) return;
    data.dm = data.dm || {}; const items = (data.dm[dmKey(myTg, fid)] || []).slice(-60);
    if (myU.unread && myU.unread[fid]) { delete myU.unread[fid]; save(); }
    return send(ws, { t: "dmHistory", with: fid, items });
  }
  if (msg.t === "dm") {
    const fid = String(msg.to || ""); if (!myU || !(myU.friends || []).includes(fid)) return send(ws, { t: "error", msg: "Писать можно только друзьям" });
    const text = String(msg.text || "").replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) return;
    const now = Date.now(); if (now - (ws.lastDm || 0) < 700) return send(ws, { t: "error", msg: "Не так быстро" });
    ws.lastDm = now;
    data.dm = data.dm || {}; const k = dmKey(myTg, fid), m = { f: myTg, text, ts: now };
    data.dm[k] = [...(data.dm[k] || []), m].slice(-100);
    const fu = data.users[fid]; fu.unread = fu.unread || {}; fu.unread[myTg] = Math.min(99, (fu.unread[myTg] || 0) + 1);
    save();
    for (const w of wsOf(myTg)) send(w, { t: "dm", with: fid, m });
    const online = wsOf(fid);
    for (const w of online) send(w, { t: "dm", with: myTg, m, from: { name: displayName(myU), avatar: avatarUrl(myTg) } });
    // не в игре — бот напомнит, но не чаще раза в 10 минут
    if (!online.length && BOT_TOKEN && now - (dmBotT.get(k + fid) || 0) > 600000) {
      dmBotT.set(k + fid, now);
      tg("sendMessage", { chat_id: fid, text: `💬 ${displayName(myU)}: ${text}`, reply_markup: { inline_keyboard: [[{ text: "Ответить в игре", web_app: { url: appUrl() } }]] } }, { quiet: true });
    }
    return;
  }
  if (msg.t === "addFriend") {
    if (!myU) return send(ws, { t: "error", msg: "Друзья работают в Telegram" });
    let fid = null;
    if (msg.pid && String(msg.pid).startsWith("tg")) fid = String(msg.pid).slice(2);
    else { const c = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); fid = Object.keys(data.users).find(id => data.users[id].fcode === c) || null; if (!fid) return send(ws, { t: "error", msg: "Такого кода нет" }); }
    if (fid === myTg) return send(ws, { t: "error", msg: "Это твой собственный код 🙂" });
    const err = makeFriends(myTg, fid);
    if (err) return send(ws, { t: "error", msg: err });
    return send(ws, { t: "toast", msg: `${displayName(data.users[fid])} теперь в друзьях` });
  }
  if (msg.t === "delFriend") {
    if (!myU) return; const fid = String(msg.id || "");
    myU.friends = (myU.friends || []).filter(x => x !== fid);
    const fu = data.users[fid]; if (fu) fu.friends = (fu.friends || []).filter(x => x !== myTg);
    save(); sendFriends(myTg); if (fu) sendFriends(fid); return;
  }
  if (msg.t === "inviteFriend") {
    const room = ws.room, fid = String(msg.id || "");
    if (!myU || !(myU.friends || []).includes(fid)) return send(ws, { t: "error", msg: "Это не твой друг" });
    if (!room || room.st.practice) return send(ws, { t: "error", msg: "Сначала создай стол" });
    if (room.st.players.some(p => p.id === "tg" + fid)) return send(ws, { t: "toast", msg: "Он уже за столом" });
    ws.invT = ws.invT || {}; const now = Date.now();
    if (now - (ws.invT[fid] || 0) < 20000) return send(ws, { t: "error", msg: "Уже позвал, подожди немного" });
    ws.invT[fid] = now;
    const from = { name: displayName(myU), avatar: avatarUrl(myTg) }, code = room.st.code, online = wsOf(fid);
    if (online.length) for (const w of online) send(w, { t: "invite", from, code });
    else if (BOT_TOKEN) tg("sendMessage", { chat_id: fid, text: `${from.name} зовёт тебя за стол в китайского дурака 🃏`, reply_markup: { inline_keyboard: [[{ text: "🃏 Сесть за стол", web_app: { url: appUrl(code) } }]] } }, { quiet: true });
    return send(ws, { t: "toast", msg: online.length ? `Позвал ${displayName(data.users[fid])}` : `${displayName(data.users[fid])} не в игре — отправил приглашение в Telegram` });
  }
  if (msg.t === "typing") {
    const room = ws.room; if (!room || !room.st.players.some(p => p.id === me.id)) return;
    const now = Date.now(); if (now - (ws.lastTyping || 0) < 1500) return; ws.lastTyping = now;
    for (const s of room.subs) if (s !== ws) send(s, { t: "typing", from: me.id });
    return;
  }
  if (msg.t === "chat") {
    const room = ws.room; if (!room || !room.st.players.some(p => p.id === me.id)) return;
    const text = String(msg.text || "").replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim().slice(0, 50);
    if (!text) return;
    const now = Date.now(); if (now - (ws.lastChat || 0) < 1500) return send(ws, { t: "error", msg: "Не так быстро" });
    ws.lastChat = now;
    for (const s of room.subs) send(s, { t: "chat", from: me.id, text });
    return;
  }
  if (msg.t === "react") {
    const room = ws.room, e = String(msg.e || "");
    if (!room || !myU || !SHOP.canReact(myU, e)) return;
    const now = Date.now();
    if (now - (ws.lastReact || 0) < 1200) return;
    ws.lastReact = now;
    for (const s of room.subs) send(s, { t: "react", from: me.id, e });
    return;
  }
  if (msg.t === "exit") {
    if (ws.room) {
      const room = ws.room;
      room.subs.delete(ws);
      ws.room = null;
      if (room.st.practice) { clearTimeout(room.timer); rooms.delete(room.st.code); }
      else { checkCountdown(room); broadcast(room); }
    }
    sendOpenTables(ws);
    return;
  }
  if (msg.t === "close") {
    const room = ws.room;
    if (!room || room.st.host !== me.id) return;
    closeRoom(room.st.code);
    return;
  }
  if (msg.t === "leaveTable") {
    const room = ws.room;
    if (!room) return sendOpenTables(ws);
    const st = room.st;
    room.subs.delete(ws); ws.room = null;
    if (st.status === "lobby" || st.status === "over") {
      st.players = st.players.filter(p => p.id !== me.id);
      if (st.rematch) delete st.rematch[me.id];
      if (!st.players.some(p => !p.bot)) { closeRoom(st.code); sendOpenTables(); return sendOpenTables(ws); }
      if (st.host === me.id) st.host = st.players.find(p => !p.bot).id;
      if (st.status === "over" && st.players.length < 2) { st.status = "lobby"; st.waitSince = Date.now(); st.rematch = null; }
    }
    broadcast(room); sendOpenTables(); sendOpenTables(ws);
    return;
  }
  if (DEV && msg.t === "devPatch" && ws.room) { // только для локальной проверки: подставить карты
    const st = ws.room.st, P = msg.patch || {};
    for (const k of ["hands", "up", "down", "pile", "deck", "turn"]) if (P[k] !== undefined) st[k] = P[k];
    if (P.turnMe) st.turn = st.players.findIndex(p => p.id === me.id);
    broadcast(ws.room); return scheduleBots(ws.room);
  }
  if (msg.t === "setMode") {
    const room = ws.room; if (!room) return; const st = room.st;
    if (st.host !== me.id) return send(ws, { t: "error", msg: "Режим выбирает создатель стола" });
    if (st.practice || (st.status !== "lobby" && st.status !== "over")) return send(ws, { t: "error", msg: "Режим можно менять только между партиями" });
    setMode(st, String(msg.mode), msg.amount); broadcast(room); return;
  }
  if (msg.t === "raise") { // предложить поднять ставку
    const room = ws.room; if (!room) return; const st = room.st;
    if (st.mode !== "stake" || st.status !== "play" || !st.players.some(p => p.id === me.id)) return;
    if (st.raise) return send(ws, { t: "error", msg: "Уже ждём ответа на прошлое предложение" });
    if (st.raises >= 3) return send(ws, { t: "error", msg: "Больше поднимать нельзя — максимум 3 раза за партию" });
    const amount = st.stake * Math.pow(2, st.raises);
    if (st.players.some(p => (userOf(p.id) || { coins: 0 }).coins < amount)) return send(ws, { t: "error", msg: `У кого-то не хватает $${amount}` });
    st.raise = { by: me.id, amount, yes: { [me.id]: true }, until: Date.now() + 20000 };
    clearTimeout(room.raiseT); room.raiseT = setTimeout(() => { if (st.raise) { st.raise = null; st.log = ["Ставку не подняли — никто не ответил", ...(st.log || [])].slice(0, 8); broadcast(room); } }, 20000);
    broadcast(room); return;
  }
  if (msg.t === "raiseAnswer") {
    const room = ws.room; if (!room) return; const st = room.st, r = st.raise;
    if (!r || !st.players.some(p => p.id === me.id) || r.yes[me.id]) return;
    if (!msg.yes) { st.raise = null; clearTimeout(room.raiseT); st.log = [`${me.name} не стал поднимать ставку`, ...(st.log || [])].slice(0, 8); broadcast(room); return; }
    r.yes[me.id] = true;
    if (st.players.every(p => r.yes[p.id])) {
      const poor = st.players.find(p => (userOf(p.id) || { coins: 0 }).coins < r.amount);
      if (poor) { st.raise = null; st.log = [`${poor.name}: не хватает денег`, ...(st.log || [])].slice(0, 8); broadcast(room); return; }
      for (const p of st.players) giveCoins(p.id.slice(2), -r.amount, "Подняли ставку");
      st.pot += r.amount * st.players.length; st.raises++; st.raise = null; clearTimeout(room.raiseT);
      st.lastRaise = { amount: r.amount, pot: st.pot, seq: (st.lastRaise ? st.lastRaise.seq : 0) + 1 };
      st.log = [`💰 Ставку подняли: в банке $${st.pot}`, ...(st.log || [])].slice(0, 8);
    }
    broadcast(room); return;
  }
  if (msg.t === "act" && msg.a === "start" && ws.room && ws.room.st.mode === "stake" && ws.room.st.host === me.id) {
    const err = collectStake(ws.room); if (err) return send(ws, { t: "error", msg: err });
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
  clearTimeout(room.turnT);
  clearTimeout(room.cdT);
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
const casino = createCasino({ data, save, users: new Proxy({}, { get: (_, id) => data.users[id] }) });
const admin = require("./admin")({ tg, rooms, getData: () => data, data, save, adminIds: ADMIN_IDS, kickUser, closeRoom, onlineIds, onlineSnapshot: () => onlineSnapshot(), demoView: id => demoOn(id) ? demoAdd(onlineSnapshot()) : null, startedAt, sendProfile: id => sendProfile(id), appUrl, giveCoins, clearAvatar: id => { avatars.delete(String(id)); saveAvatar(String(id)); sendProfile(String(id)); } });

// Чистим комнаты, где давно никто не играл
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.st.updated;
    if (idle > 6 * 3600e3 || (room.subs.size === 0 && idle > 30 * 60e3)) { clearTimeout(room.timer); clearTimeout(room.turnT); clearTimeout(room.cdT); rooms.delete(code); }
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
  const avm = /^\/av\/(\d+)$/.exec(url.pathname);
  if (avm) {
    const a = avatars.get(avm[1]);
    if (!a) { res.writeHead(404); return res.end(); }
    const type = a.buf[0] === 0x89 ? "image/png" : a.buf[0] === 0x52 ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=604800, immutable", "x-content-type-options": "nosniff" });
    return res.end(a.buf);
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end(DEV ? indexHtml.toString().replace("window.__DEV__=false", "window.__DEV__=true") : indexHtml);
  }
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 96 * 1024 });
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", data => {
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    if (ws.room) ws.room.subs.delete(ws);
    const id = ws.user && ws.user.id && ws.user.id.startsWith("tg") ? ws.user.id.slice(2) : null;
    if (id && data.users[id]) { data.users[id].last = Date.now(); if (!wsOf(id).length) notifyFriends(id); }
    sendOnline();
  });
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
