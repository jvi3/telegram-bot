// Правила китайского дурака (by Кащей).
// 8 — прозрачная, 2 — бьёт любую карту (на неё можно класть любую), 10 — сжигает стопку.
"use strict";

const ORDER = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];
const SUITS = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SPECIAL = { "8": true, "2": true, "10": true };
const BOT_NAMES = ["Бот Гоша", "Бот Зина", "Бот Петрович", "Бот Люся"];

const val = r => ORDER.indexOf(r);
const rk = c => c.slice(0, -1);
const su = c => c.slice(-1);
const pretty = c => rk(c) + SUITS[su(c)];

function plural(n) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return "карту";
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return "карты";
  return "карт";
}

function newDeck() {
  const d = [];
  for (const s of "shdc") for (const r of ORDER) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function effectiveTop(pile) {
  for (let i = pile.length - 1; i >= 0; i--) if (rk(pile[i]) !== "8") return pile[i];
  return null;
}

function canPlay(r, pile) {
  if (r === "8" || r === "10" || r === "2") return true;
  const t = effectiveTop(pile);
  if (!t) return true;
  if (rk(t) === "2") return true; // двойка бьёт любую карту, но на неё можно класть любую
  return val(r) >= val(rk(t));
}

function sourceOf(st, pid) {
  if ((st.hands[pid] || []).length) return "hands";
  if ((st.up[pid] || []).length) return "up";
  if ((st.down[pid] || []).length) return "down";
  return null;
}

const nameOf = (st, pid) => (st.players.find(p => p.id === pid) || {}).name || "Игрок";
const sortHand = h => h.sort((a, b) => val(rk(a)) - val(rk(b)) || a.localeCompare(b));
function log(st, msg) { st.log = [msg, ...(st.log || [])].slice(0, 8); }
function isOut(st, pid) {
  return !st.hands[pid].length && !st.up[pid].length && !st.down[pid].length && !st.deck.length;
}

function advance(st) {
  const n = st.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (st.turn + k) % n;
    if (!st.finished.includes(st.players[i].id)) { st.turn = i; return; }
  }
}

function finish(st, pid) {
  if (st.finished.includes(pid)) return;
  st.finished.push(pid);
  log(st, `${nameOf(st, pid)} вышел из игры`);
  const left = st.players.filter(p => !st.finished.includes(p.id));
  if (left.length <= 1) {
    st.status = "over";
    st.loser = left[0] ? left[0].id : null;
    if (st.loser) log(st, `${nameOf(st, st.loser)} — дурак!`);
  }
}

function topFourSame(pile) {
  if (pile.length < 4) return false;
  const r = rk(pile[pile.length - 1]);
  return pile.slice(-4).every(c => rk(c) === r);
}

function afterPlay(st, pid, r) {
  const h = st.hands[pid];
  while (h.length < 3 && st.deck.length) h.push(st.deck.pop());
  sortHand(h);
  const burn = r === "10" || topFourSame(st.pile);
  if (!burn) st.burnStreak = 0;
  if (burn) {
    st.burned += st.pile.length;
    st.pile = [];
    st.pileBy = [];
    st.burnStreak = (st.burnStreak || 0) + 1;
    log(st, r === "10"
      ? `${nameOf(st, pid)} сбросил стопку десяткой и ходит ещё`
      : `Четыре одинаковые — стопка сгорела, ${nameOf(st, pid)} ходит ещё`);
  }
  if (isOut(st, pid)) {
    finish(st, pid);
    if (st.status === "over") return;
    advance(st);
    return;
  }
  if (!burn) advance(st);
}

function deal(st) {
  // реванш: остаются боты и те, кто нажал «Играть ещё»
  if (st.rematch) { st.players = st.players.filter(p => p.bot || st.rematch[p.id]); if (!st.players.some(p => p.id === st.host)) { const h = st.players.find(p => !p.bot); if (h) st.host = h.id; } }
  st.rematch = null; st.countdownAt = null;
  const d = newDeck();
  st.hands = {}; st.up = {}; st.down = {}; st.ready = {};
  for (const p of st.players) {
    st.down[p.id] = d.splice(0, 3);
    st.up[p.id] = d.splice(0, 3);
    st.hands[p.id] = sortHand(d.splice(0, 3));
    st.ready[p.id] = false;
  }
  st.prevLoser = st.loser || null;
  st.deck = d; st.pile = []; st.pileBy = []; st.burned = 0; st.finished = []; st.loser = null; st.turn = 0; st.last = null; st.burnStreak = 0;
  st.status = "swap";
  st.log = [];
  log(st, "Карты розданы. Поменяйте карты в руке и открытые, затем нажмите «Готов».");
}

function startPlay(st) {
  let best = null, bi = 0;
  st.players.forEach((p, i) => {
    for (const c of st.hands[p.id]) {
      const r = rk(c);
      if (SPECIAL[r]) continue;
      const v = val(r);
      if (best === null || v < best) { best = v; bi = i; }
    }
  });
  st.turn = bi;
  st.status = "play";
  log(st, `Игра началась. Первым ходит ${st.players[bi].name}${best !== null ? ` (младшая карта: ${ORDER[best]})` : ""}`);
}

function botScore(c) {
  const r = rk(c);
  return r === "2" ? 20 : r === "10" ? 19 : r === "8" ? 16 : val(r);
}

// Действия. Возвращают строку с ошибкой, false (ничего не изменилось) или undefined (ок).
const A = {
  join(st, pid, name) {
    const p = st.players.find(p => p.id === pid);
    if (p) { p.name = name; return; }
    if (st.status !== "lobby") return "Игра уже идёт, дождитесь следующей партии";
    if (st.players.length >= 5) return "За столом уже 5 игроков";
    st.players.push({ id: pid, name });
  },
  leave(st, pid) {
    if (st.status !== "lobby") return "Во время партии выйти нельзя";
    st.players = st.players.filter(p => p.id !== pid);
    const humans = st.players.filter(p => !p.bot);
    if (st.host === pid && humans.length) st.host = humans[0].id;
  },
  start(st, pid) {
    if (st.host !== pid) return "Начать может только создатель комнаты";
    if (st.players.length < 2) return "Нужно хотя бы 2 игрока";
    deal(st);
  },
  swap(st, pid, hi, ui) {
    if (st.status !== "swap" || st.ready[pid]) return false;
    const h = st.hands[pid], u = st.up[pid];
    if (!Number.isInteger(hi) || !Number.isInteger(ui) || h[hi] == null || u[ui] == null) return false;
    [h[hi], u[ui]] = [u[ui], h[hi]];
    sortHand(h);
  },
  ready(st, pid) {
    if (st.status !== "swap" || !(pid in st.ready)) return false;
    st.ready[pid] = true;
    if (st.players.every(p => st.ready[p.id])) startPlay(st);
  },
  play(st, pid, src, cards) {
    if (st.status !== "play") return false;
    if (st.players[st.turn].id !== pid) return "Сейчас не твой ход";
    if (src !== "hands" && src !== "up") return false;
    if (sourceOf(st, pid) !== src) return "Сначала нужно сыграть карты из руки";
    if (!Array.isArray(cards) || !cards.length || cards.length > 4) return false;
    const arr = st[src][pid];
    const pool = arr.slice();
    for (const c of cards) {
      const i = pool.indexOf(c);
      if (i < 0) return "Эти карты уже не у тебя";
      pool.splice(i, 1);
    }
    const r = rk(cards[0]);
    if (!cards.every(c => rk(c) === r)) return "Класть можно только одинаковые карты";
    if (!canPlay(r, st.pile)) return "Эта карта не бьёт верхнюю";
    for (const c of cards) arr.splice(arr.indexOf(c), 1);
    st.pile.push(...cards);
    st.pileBy = (st.pileBy || []).concat(cards.map(() => pid));
    st.last = { pid, cards };
    log(st, `${nameOf(st, pid)}: ${cards.map(pretty).join(" ")}${r === "8" ? " (прозрачная)" : ""}`);
    afterPlay(st, pid, r);
  },
  blind(st, pid, i) {
    if (st.status !== "play") return false;
    if (st.players[st.turn].id !== pid) return "Сейчас не твой ход";
    if (sourceOf(st, pid) !== "down") return false;
    if (!Number.isInteger(i) || i < 0 || i >= st.down[pid].length) return false;
    const c = st.down[pid].splice(i, 1)[0];
    const r = rk(c);
    st.seq = (st.seq || 0) + 1;
    st.lastBlind = { pid, card: c, ok: canPlay(r, st.pile), n: st.pile.length + 1, seq: st.seq };
    if (st.lastBlind.ok) {
      st.pile.push(c);
      st.pileBy = (st.pileBy || []).concat([pid]);
      st.last = { pid, cards: [c] };
      log(st, `${nameOf(st, pid)} открыл ${pretty(c)} вслепую — подошла`);
      afterPlay(st, pid, r);
    } else {
      const n = st.pile.length + 1;
      st.hands[pid].push(c, ...st.pile);
      sortHand(st.hands[pid]);
      st.lastTake = { pid, n, seq: st.seq, blind: true };
      st.pile = [];
      st.pileBy = [];
      st.burnStreak = 0;
      st.last = null;
      log(st, `${nameOf(st, pid)} открыл закрытую карту — не подошла, забрал ${n} ${plural(n)}`);
      advance(st);
    }
  },
  take(st, pid) {
    if (st.status !== "play") return false;
    if (st.players[st.turn].id !== pid) return "Сейчас не твой ход";
    if (!st.pile.length) return "Стопка пустая — положи любую карту";
    const n = st.pile.length;
    st.hands[pid].push(...st.pile);
    sortHand(st.hands[pid]);
    st.seq = (st.seq || 0) + 1;
    st.lastTake = { pid, n, seq: st.seq };
    st.pile = [];
    st.pileBy = [];
    st.burnStreak = 0;
    st.last = null;
    log(st, `${nameOf(st, pid)} забрал стопку (${n} ${plural(n)})`);
    advance(st);
  },
  again(st, pid) { return A.vote(st, pid, true); },
  // «Играть ещё» после партии
  vote(st, pid, yes) {
    if (st.status !== "over" || !st.players.some(p => p.id === pid)) return false;
    st.rematch = st.rematch || {};
    st.rematch[pid] = yes !== false;
  },
  // открытый стол: виден всем в меню
  setOpen(st, pid, open) {
    if (st.host !== pid) return "Это решает создатель стола";
    if (st.practice) return false;
    st.open = !!open;
  },
  // Выбор трёх карт, которые лягут сверху на закрытые (из шести: рука + открытые)
  arrange(st, pid, upCards) {
    if (st.status !== "swap" || st.ready[pid] === undefined || st.ready[pid]) return false;
    const pool = [...st.hands[pid], ...st.up[pid]];
    if (!Array.isArray(upCards) || upCards.length !== 3 || new Set(upCards).size !== 3) return "Выбери ровно 3 карты";
    if (!upCards.every(c => pool.includes(c))) return false;
    st.up[pid] = upCards.slice();
    st.hands[pid] = sortHand(pool.filter(c => !upCards.includes(c)));
    return A.ready(st, pid);
  },
  setTimer(st, pid, sec) {
    if (st.host !== pid) return "Таймер включает создатель комнаты";
    if (st.status !== "lobby" && st.status !== "over") return "Таймер можно поменять только между партиями";
    st.timer = sec === 30 ? 30 : 0;
  },
  addBot(st, pid) {
    if (st.host !== pid) return "Ботов добавляет создатель комнаты";
    if (st.status !== "lobby") return false;
    if (st.players.length >= 5) return "За столом уже 5 игроков";
    const used = st.players.map(p => p.name);
    const name = BOT_NAMES.find(n => !used.includes(n)) || "Бот";
    st.players.push({ id: "bot" + Math.random().toString(36).slice(2, 8), name, bot: true });
  },
  kick(st, pid, id) {
    if (st.host !== pid || st.status !== "lobby") return false;
    const p = st.players.find(p => p.id === id);
    if (!p || !p.bot) return false;
    st.players = st.players.filter(p => p.id !== id);
  },
  bot(st, id) {
    if (st.status === "swap") {
      if (st.ready[id]) return false;
      const all = [...st.hands[id], ...st.up[id]].sort((a, b) => botScore(b) - botScore(a));
      st.up[id] = all.slice(0, 3);
      st.hands[id] = sortHand(all.slice(3));
      return A.ready(st, id);
    }
    if (st.status !== "play" || st.players[st.turn].id !== id) return false;
    const src = sourceOf(st, id);
    if (src === "down") return A.blind(st, id, Math.floor(Math.random() * st.down[id].length));
    const arr = st[src][id];
    const ranks = [...new Set(arr.map(rk))].filter(r => canPlay(r, st.pile));
    if (!ranks.length) return A.take(st, id);
    const normal = ranks.filter(r => !SPECIAL[r]).sort((a, b) => val(a) - val(b));
    let r;
    if (normal.length) r = normal[0];
    else {
      const pref = st.pile.length >= 5 ? ["10", "8", "2"] : ["8", "2", "10"];
      r = pref.find(x => ranks.includes(x));
    }
    return A.play(st, id, src, arr.filter(c => rk(c) === r));
  },
};

// Кто из ботов должен сейчас походить (или null)
function botToAct(st) {
  if (st.status === "swap") {
    const b = st.players.find(p => p.bot && !st.ready[p.id]);
    return b ? b.id : null;
  }
  if (st.status === "play") {
    const p = st.players[st.turn];
    return p && p.bot ? p.id : null;
  }
  return null;
}

module.exports = { A, BOT_NAMES, deal, botToAct, rk, canPlay, sourceOf };
