// Казино на игровую валюту (by Кащей). Все броски делает сервер, чтобы никто не подкрутил шансы.
"use strict";
const crypto = require("crypto");
const rnd = n => crypto.randomInt(n);

/* ---------- фруктовые слоты: 3 барабана, линия по центру, отдача ~96% ---------- */
const SYM = ["cherry", "lemon", "orange", "grape", "bell", "bar", "seven"];
const W = { cherry: 7, lemon: 6, orange: 5, grape: 4, bell: 3, bar: 2, seven: 1 };
const WT = Object.values(W).reduce((a, b) => a + b, 0);
const PAY3 = { seven: 120, bar: 50, bell: 25, grape: 15, orange: 12, lemon: 9, cherry: 7 };
function pickSym() { let r = rnd(WT); for (const s of SYM) { r -= W[s]; if (r < 0) return s; } return "cherry"; }
function slotPay(a, b, c) {
  if (a === b && b === c) return PAY3[a];
  if ([a, b, c].filter(x => x === "cherry").length === 2) return 3;
  if ([a, b, c].filter(x => x === "seven").length === 2) return 6;
  if (a === "cherry") return 1;
  return 0;
}
function spinSlots() {
  // для красоты присылаем и соседние символы (сверху и снизу), выигрыш считается только по центру
  const reels = [0, 1, 2].map(() => [pickSym(), pickSym(), pickSym()]);
  const line = reels.map(r => r[1]);
  return { reels, line, mult: slotPay(...line) };
}

/* ---------- рулетка: 15 ячеек, 0 — зелёное, 1–7 красные, 8–14 чёрные ---------- */
const ROUL = Array.from({ length: 15 }, (_, i) => (i === 0 ? "green" : i <= 7 ? "red" : "black"));
function spinRoulette(pick) {
  const n = rnd(15), color = ROUL[n];
  const mult = color === pick ? (pick === "green" ? 14 : 2) : 0;
  return { n, color, mult };
}

/* ---------- выше / ниже: множитель растёт с каждым угаданным, отдача 95% за раунд ---------- */
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const SUITS = ["s", "h", "d", "c"];
const drawCard = () => RANKS[rnd(13)] + SUITS[rnd(4)];
const rIdx = c => RANKS.indexOf(c.slice(0, -1));
function hiloChance(card, up) { const i = rIdx(card); return (up ? 12 - i : i) / 13; }


/* ---------- автоматы 5×3 с бонусами: «Лаки 7» (бесплатные вращения) и «Сундук Кащея» (выбор сундука) ---------- */
const LINES = [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2]];
const MACHINES = {
  lucky: {
    name: "Лаки 7",
    weights: { cherry: 16, lemon: 14, grape: 12, bell: 8, bar: 6, seven: 4, wild: 3, star: 3 },
    pay: { cherry: [3, 8, 25], lemon: [5, 10, 33], grape: [7, 17, 50], bell: [13, 33, 100], bar: [20, 67, 200], seven: [42, 167, 800], wild: [42, 167, 800] },
    wild: "wild", scatter: "star", free: { 3: 8, 4: 12, 5: 20 }, freeMult: 2,
  },
  chest: {
    name: "Сундук Кащея",
    weights: { coin: 16, clover: 14, gem: 11, crown: 8, bar: 6, seven: 4, wild: 3, chest: 3 },
    pay: { coin: [3, 7, 20], clover: [4, 8, 27], gem: [7, 16, 47], crown: [11, 33, 107], bar: [16, 53, 160], seven: [33, 133, 667], wild: [33, 133, 667] },
    wild: "wild", scatter: "chest", prizes: { 3: [5, 10, 20], 4: [10, 20, 40], 5: [25, 50, 100] },
  },
};
function pickW(weights) { const tot = Object.values(weights).reduce((a, b) => a + b, 0); let r = rnd(tot); for (const [s, w] of Object.entries(weights)) { r -= w; if (r < 0) return s; } return Object.keys(weights)[0]; }
function spinGrid(m) { return [0, 1, 2, 3, 4].map(() => [pickW(m.weights), pickW(m.weights), pickW(m.weights)]); }
function evalGrid(m, grid, lineBet) {
  let win = 0; const lines = [];
  LINES.forEach((ln, li) => {
    const syms = ln.map((row, reel) => grid[reel][row]);
    let target = syms.find(x => x !== m.wild) || m.wild;
    if (target === m.scatter) return;
    let count = 0;
    for (const x of syms) { if (x === target || x === m.wild) count++; else break; }
    if (syms[0] === m.scatter) return;
    const p = m.pay[target];
    if (count >= 3 && p) { const w = p[count - 3] * lineBet; win += w; lines.push({ li, count, sym: target, w }); }
  });
  const scat = grid.flat().filter(x => x === m.scatter).length;
  return { win, lines, scat };
}

module.exports = function createCasino({ data, save, users }) {
  const bonuses = new Map(); // tgId -> { prizes, bet }
  const sessions = new Map(); // tgId -> { stake, mult, card, steps }
  data.casino = data.casino || {};
  const stat = (g, bet, paid) => { const s = data.casino[g] || (data.casino[g] = { n: 0, bet: 0, paid: 0 }); s.n++; s.bet += bet; s.paid += paid; };

  function takeBet(u, bet) {
    bet = Math.floor(Number(bet));
    if (!Number.isFinite(bet) || bet < 1) return { err: "Ставка — от $1" };
    if (bet > u.coins) return { err: `Не хватает денег: у тебя $${u.coins}` };
    u.coins -= bet;
    return { bet };
  }

  // Возвращает объект ответа для игрока (или { err })
  function play(tgId, msg) {
    const u = users[tgId];
    if (!u) return { err: "Казино работает только в Telegram" };
    const game = String(msg.game || "");

    if (game === "slots") {
      const b = takeBet(u, msg.bet); if (b.err) return b;
      const r = spinSlots(), win = b.bet * r.mult;
      u.coins += win; stat("slots", b.bet, win); save();
      return { game, bet: b.bet, ...r, win, coins: u.coins };
    }
    if (game === "lucky" || game === "chest") {
      const m = MACHINES[game];
      if (game === "chest" && msg.action === "pick") {
        const bo = bonuses.get(tgId); if (!bo) return { err: "Бонуса нет" };
        const i = Math.max(0, Math.min(2, Math.floor(Number(msg.i) || 0)));
        bonuses.delete(tgId);
        const win = bo.prizes[i] * bo.bet; u.coins += win; const st = data.casino.chest; if (st) st.paid += win; save();
        return { game, action: "pick", i, prizes: bo.prizes, win, coins: u.coins };
      }
      if (game === "chest" && bonuses.has(tgId)) return { err: "Сначала выбери сундук" };
      const b = takeBet(u, msg.bet); if (b.err) return b;
      const lineBet = b.bet / LINES.length;
      const grid = spinGrid(m), ev = evalGrid(m, grid, lineBet);
      let win = ev.win; const res = { game, bet: b.bet, grid, lines: ev.lines, scat: ev.scat };
      if (game === "lucky" && m.free[Math.min(5, ev.scat)]) {
        const n = m.free[Math.min(5, ev.scat)], spins = [];
        for (let k = 0; k < n; k++) { const g = spinGrid(m), e = evalGrid(m, g, lineBet); const w = e.win * m.freeMult; spins.push({ grid: g, lines: e.lines, win: Math.floor(w) }); win += w; }
        res.free = spins;
      }
      if (game === "chest" && m.prizes[Math.min(5, ev.scat)]) {
        const pr = m.prizes[Math.min(5, ev.scat)].slice();
        for (let i = pr.length - 1; i > 0; i--) { const j = rnd(i + 1); [pr[i], pr[j]] = [pr[j], pr[i]]; }
        bonuses.set(tgId, { prizes: pr, bet: b.bet }); res.bonus = { count: ev.scat };
      }
      win = Math.floor(win);
      u.coins += win; stat(game, b.bet, win); save();
      return { ...res, baseWin: Math.floor(ev.win), win, coins: u.coins };
    }
    if (game === "roulette") {
      const pick = ["red", "black", "green"].includes(msg.pick) ? msg.pick : null;
      if (!pick) return { err: "Выбери цвет" };
      const b = takeBet(u, msg.bet); if (b.err) return b;
      const r = spinRoulette(pick), win = b.bet * r.mult;
      u.coins += win; stat("roulette", b.bet, win); save();
      return { game, bet: b.bet, pick, ...r, win, coins: u.coins };
    }
    if (game === "hilo") {
      const act = String(msg.action || "");
      const s = sessions.get(tgId);
      if (act === "start") {
        if (s) return { err: "Сначала доиграй или забери выигрыш" };
        const b = takeBet(u, msg.bet); if (b.err) return b;
        const ns = { stake: b.bet, mult: 1, card: drawCard(), steps: 0 };
        sessions.set(tgId, ns); stat("hilo", b.bet, 0); save();
        return { game, action: act, card: ns.card, mult: 1, stake: ns.stake, coins: u.coins, live: true };
      }
      if (!s) return { err: "Сначала сделай ставку" };
      if (act === "guess") {
        const up = !!msg.up, p = hiloChance(s.card, up);
        if (p <= 0) return { err: up ? "Старше этой карты ничего нет" : "Младше этой карты ничего нет" };
        const next = drawCard(), i = rIdx(s.card), j = rIdx(next), ok = up ? j > i : j < i;
        const prev = s.card; s.card = next;
        if (!ok) { sessions.delete(tgId); save(); return { game, action: act, prev, card: next, ok: false, mult: 0, stake: s.stake, win: 0, coins: u.coins, live: false }; }
        s.raw = (s.raw || 1) * (s.steps === 0 ? 0.95 : 1) / p; // комиссия казино берётся один раз за раунд
        s.mult = Math.min(1000, Math.floor(s.raw * 100) / 100); s.steps++;
        return { game, action: act, prev, card: next, ok: true, mult: s.mult, stake: s.stake, can: Math.floor(s.stake * s.mult), coins: u.coins, live: true };
      }
      if (act === "cash") {
        if (s.steps === 0) return { err: "Угадай хотя бы одну карту" };
        const win = Math.floor(s.stake * s.mult);
        sessions.delete(tgId); u.coins += win;
        const st = data.casino.hilo; if (st) st.paid += win;
        save();
        return { game, action: act, win, mult: s.mult, coins: u.coins, live: false };
      }
      if (act === "resume") {
        if (!s) return { game, action: act, live: false, coins: u.coins };
        return { game, action: act, card: s.card, mult: s.mult, stake: s.stake, can: Math.floor(s.stake * s.mult), steps: s.steps, coins: u.coins, live: true };
      }
      return { err: "Неизвестное действие" };
    }
    return { err: "Такой игры нет" };
  }
  return { play, ROUL, PAY3, MACHINES: Object.fromEntries(Object.entries(MACHINES).map(([k, m]) => [k, { name: m.name, pay: m.pay, free: m.free, prizes: m.prizes }])) };
};
module.exports.slotPay = slotPay;
module.exports._eng = { MACHINES, spinGrid, evalGrid, LINES };
module.exports.W = W;
module.exports.hiloChance = hiloChance;
