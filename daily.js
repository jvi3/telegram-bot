// Ежедневные поводы зайти: серия входов, три необычных задания, колесо удачи и сундуки с фонами и колодами.
"use strict";
const crypto = require("crypto");
const rnd = n => crypto.randomInt(n);

const BIG = "Китайский сундук";
const STREAK = [{ coins: 5 }, { coins: 8 }, { coins: 12 }, { coins: 15 }, { chest: "mini" }, { coins: 25 }, { chest: "big" }];

// Задания: все выполнимы в партии с ботами. scope "game" — внутри одной партии.
const QUESTS = [
  { id: "pyro", icon: "🔥", name: "Пироман", desc: "Сожги стопку десяткой 2 раза за одну партию", need: 1, stars: 2 },
  { id: "glass", icon: "🪞", name: "Двойное стекло", desc: "Положи восьмёрку прямо на восьмёрку", need: 1, stars: 2 },
  { id: "clean", icon: "🧊", name: "Ни шагу назад", desc: "Выиграй партию, ни разу не взяв стопку", need: 1, stars: 3 },
  { id: "pairs", icon: "👯", name: "Близнецы", desc: "Сходи сразу двумя или больше одинаковыми картами 3 раза", need: 3, stars: 1 },
  { id: "lastblow", icon: "🎯", name: "Последний удар", desc: "Выйди из партии, сыграв последней двойку", need: 1, stars: 2 },
  { id: "blind", icon: "🙈", name: "Вслепую", desc: "Пусть две закрытые карты подряд подойдут", need: 1, stars: 2 },
  { id: "glutton", icon: "🐷", name: "Обжора", desc: "Заставь соперника забрать 8+ карт после твоего хода", need: 1, stars: 2 },
  { id: "dburn", icon: "💥", name: "Двойной поджог", desc: "Сожги стопку два раза за один ход", need: 1, stars: 3 },
  { id: "quartet", icon: "🃏", name: "Квартет", desc: "Сожги стопку четырьмя одинаковыми картами", need: 1, stars: 3 },
  { id: "comeback", icon: "🦅", name: "Камбэк", desc: "Набери в руку 10+ карт и всё равно выйди первым", need: 1, stars: 3 },
  { id: "king", icon: "👑", name: "Царь горы", desc: "Выйди первым, когда за столом 4 игрока и больше", need: 1, stars: 2 },
  { id: "ace2", icon: "⚡", name: "Двойка на туза", desc: "Положи двойку прямо на туза", need: 1, stars: 1 },
];
const Q = Object.fromEntries(QUESTS.map(q => [q.id, q]));
const REWARD = { 1: 10, 2: 12, 3: 15 };

// Колесо: 8 секторов (для картинки), шанс у каждого приза свой
const WHEEL = ["c5", "c20", "c3", "x2", "c10", "chest", "c5", "c50"];
const WHEEL_W = { c3: 30, c5: 28, c10: 18, x2: 10, chest: 5, c20: 7, c50: 2 };

module.exports = function createDaily({ data, save, SHOP, giveCoins, sendTo }) {
  const today = SHOP.today;
  const yesterday = () => SHOP.today(Date.now() - 864e5);
  const D = u => (u.dly = u.dly || {});

  function hash(s) { return parseInt(crypto.createHash("sha256").update(s).digest("hex").slice(0, 8), 16); }
  // Три задания дня: лёгкое, среднее и трудное; у каждого игрока свои
  function questsFor(tg, u) {
    const d = D(u), day = today();
    if (d.qday !== day) {
      let h = hash(tg + ":" + day);
      const pick = arr => { const i = h % arr.length; h = Math.floor(h / arr.length) + 7919; return arr[i]; };
      const easy = pick(QUESTS.filter(q => q.stars <= 2));
      const mid = pick(QUESTS.filter(q => q.stars === 2 && q.id !== easy.id));
      const hard = pick(QUESTS.filter(q => q.stars === 3));
      d.qday = day; d.qs = [easy, mid, hard].map(q => ({ id: q.id, p: 0, done: false })); d.bonus = false;
    }
    return d.qs;
  }

  function view(tg) {
    const u = data.users[tg]; if (!u) return null;
    SHOP.ensureEco(u);
    const d = D(u), day = today();
    const alive = d.last === day || d.last === yesterday();
    const n = alive ? (d.n || 0) : 0; // сколько дней серии уже забрано в этом круге
    const ready = d.last !== day;
    const qs = questsFor(tg, u);
    const msk = Date.now() + 3 * 3600e3; const left = 864e5 - (msk % 864e5);
    return {
      streak: { n: ready && n >= 7 ? 0 : n, ready, rewards: STREAK.map(r => r.chest ? { chest: r.chest, name: r.chest === "big" ? BIG : "Мини-сундук" } : r) },
      quests: qs.map(s => { const q = Q[s.id]; return { ...q, p: Math.min(s.p, q.need), done: s.done, reward: REWARD[q.stars] * (d.x2 === day ? 2 : 1) }; }),
      bonus: { ready: qs.every(s => s.done) && !d.bonus, claimed: !!d.bonus },
      wheel: { ready: d.wheel !== day, segs: WHEEL },
      x2: d.x2 === day, left, bigName: BIG,
      chests: d.chests || 0,
    };
  }
  function push(tg) { const v = view(tg); if (v) sendTo(tg, { t: "daily", ...v }); }

  /* ---------- сундуки: только фоны и колоды ---------- */
  function openChest(tg, kind) {
    const u = data.users[tg]; SHOP.ensureEco(u);
    const pool = SHOP.ITEMS.filter(i => (i.type === "bg" || i.type === "deck") && i.price > 0 && !u.owned.includes(i.id));
    let list = kind === "big" ? pool.filter(i => i.price >= 80) : pool.filter(i => i.price >= 45);
    if (!list.length) list = pool;
    if (!list.length) { const c = kind === "big" ? 100 : 30; giveCoins(tg, c, `${kind === "big" ? BIG : "Мини-сундук"}: всё уже собрано`); return { kind, coins: c }; }
    // в большом сундуке дорогие вещи выпадают чаще, в маленьком — равномерно
    const w = list.map(i => kind === "big" ? i.price : 1), tot = w.reduce((a, b) => a + b, 0);
    let r = rnd(tot), it = list[0]; for (let k = 0; k < list.length; k++) { r -= w[k]; if (r < 0) { it = list[k]; break; } }
    u.owned.push(it.id); save();
    return { kind, item: { id: it.id, name: it.name, type: it.type, key: it.key, price: it.price } };
  }

  function claimStreak(tg) {
    const u = data.users[tg]; if (!u) return { err: "Только в Telegram" };
    const d = D(u), day = today();
    if (d.last === day) return { err: "Сегодня уже забрано, приходи завтра" };
    d.n = d.last === yesterday() && (d.n || 0) < 7 ? (d.n || 0) + 1 : 1;
    d.last = day; u.daily = day; save();
    const r = STREAK[d.n - 1];
    const res = { day: d.n };
    if (r.coins) giveCoins(tg, r.coins, `Серия входов: день ${d.n}`);
    else res.chest = openChest(tg, r.chest);
    push(tg); return res;
  }
  function spin(tg) {
    const u = data.users[tg]; if (!u) return { err: "Только в Telegram" };
    const d = D(u), day = today();
    if (d.wheel === day) return { err: "Колесо уже крутили сегодня" };
    d.wheel = day;
    const tot = Object.values(WHEEL_W).reduce((a, b) => a + b, 0); let r = rnd(tot), prize = "c3";
    for (const [k, w] of Object.entries(WHEEL_W)) { r -= w; if (r < 0) { prize = k; break; } }
    const idx = WHEEL.map((s, i) => s === prize ? i : -1).filter(i => i >= 0); const seg = idx[rnd(idx.length)];
    const res = { seg, prize };
    if (prize === "x2") { const qs = questsFor(tg, u); if (qs.every(s => s.done)) { res.prize = "c20"; res.swap = true; } else d.x2 = day; }
    save();
    res.apply = () => { // начисляем, когда колесо докрутится на экране
      if (res.prize.startsWith("c")) giveCoins(tg, +res.prize.slice(1), "Колесо удачи");
      else if (res.prize === "chest") res.chest = openChest(tg, "mini");
    };
    return res;
  }
  function claimBonus(tg) {
    const u = data.users[tg]; if (!u) return { err: "Только в Telegram" };
    const d = D(u), qs = questsFor(tg, u);
    if (!qs.every(s => s.done)) return { err: "Сначала выполни все три задания" };
    if (d.bonus) return { err: "Бонус-сундук уже открыт" };
    d.bonus = true; save();
    const chest = openChest(tg, "mini"); push(tg); return { chest };
  }

  /* ---------- отслеживание заданий по событиям партии ---------- */
  const tgOf = pid => pid && pid.startsWith("tg") ? pid.slice(2) : null;
  function bump(tg, id, by = 1) {
    const u = data.users[tg]; if (!u) return;
    const qs = questsFor(tg, u), s = qs.find(x => x.id === id); if (!s || s.done) return;
    s.p += by; const q = Q[id];
    if (s.p >= q.need) {
      s.done = true; const d = D(u); const amount = REWARD[q.stars] * (d.x2 === today() ? 2 : 1);
      save(); giveCoins(tg, amount, `Задание «${q.name}» выполнено`);
      sendTo(tg, { t: "questDone", id, name: q.name, icon: q.icon, amount, all: qs.every(x => x.done) });
    } else save();
    push(tg);
  }
  function ev(type, st, pid, info = {}) {
    try {
      const g = (st.qg = st.qg || {});
      const c = pid ? (g[pid] = g[pid] || { b10: 0, took: false, maxH: 0, brow: 0 }) : null;
      const tg = tgOf(pid);
      if (type === "play") {
        if (info.blind) c.brow++; else c.brow = 0;
        if (!tg) return;
        if (info.blind && c.brow === 2) bump(tg, "blind");
        if (info.r === "8" && (info.prevLit === "8" || info.n >= 2)) bump(tg, "glass");
        if (info.r === "2" && info.eff === "A") bump(tg, "ace2");
        if (info.n >= 2) bump(tg, "pairs");
      } else if (type === "burn") {
        if (info.by === "10") c.b10++;
        if (!tg) return;
        if (info.by === "10" && c.b10 === 2) bump(tg, "pyro");
        if (info.by === "four") bump(tg, "quartet");
        if (info.streak >= 2) bump(tg, "dburn");
      } else if (type === "take") {
        c.took = true; c.brow = 0; c.maxH = Math.max(c.maxH, info.hand || 0);
        const by = tgOf(info.by);
        if (by && info.by !== pid && info.n >= 8) bump(by, "glutton");
      } else if (type === "out") {
        if (!tg || info.place !== 0) { if (tg && info.r === "2") bump(tg, "lastblow"); return; }
        if (info.r === "2") bump(tg, "lastblow");
        if (!c.took) bump(tg, "clean");
        if (c.maxH >= 10) bump(tg, "comeback");
        if (st.players.length >= 4) bump(tg, "king");
      }
    } catch (e) { console.error("daily ev", e); }
  }

  return { view, push, claimStreak, spin, claimBonus, ev, openChest, BIG, _QUESTS: QUESTS };
};
