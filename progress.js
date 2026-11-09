// Долгие цели: уровень игрока, достижения и сезоны по 30 дней.
"use strict";

/* ---------- уровень ---------- */
const need = l => Math.max(200, 100 * (l - 2)); // сколько опыта нужно с уровня l на l+1
const RANKS = [[1, "Новичок"], [3, "Любитель"], [5, "Картёжник"], [10, "Шулер"], [15, "Поджигатель"], [20, "Ветеран стола"], [30, "Гроссмейстер"], [40, "Легенда"], [50, "Император"]];
const rankOf = l => RANKS.filter(r => l >= r[0]).pop()[1];
const LV_TITLES = { 10: "title:lv10", 20: "title:lv20", 30: "title:lv30", 40: "title:lv40", 50: "title:lv50" };
const XP = { game: 20, first: 50, middle: 25, quest: 40, burn: 5, ach: 100 };
const PRACTICE_XP_CAP = 800, BURN_XP_CAP = 100;
function levelReward(l) { return LV_TITLES[l] ? { title: LV_TITLES[l] } : l % 5 === 0 ? { chest: l % 10 === 0 ? "big" : "mini" } : { coins: 20 + l * 2 }; }

/* ---------- достижения ---------- */
// t: b — бронза, s — серебро, g — золото, x — тайное. c — счётчик, n — сколько нужно
const ACH = [
  { id: "first", icon: "🩸", name: "Первая кровь", desc: "Выйди первым в любой партии", c: "wins", n: 1, t: "b" },
  { id: "burn10", icon: "🕯️", name: "Искра", desc: "Сожги 10 стопок", c: "burns", n: 10, t: "b" },
  { id: "burn100", icon: "🔥", name: "Пожарный", desc: "Сожги 100 стопок", c: "burns", n: 100, t: "s" },
  { id: "trash", icon: "🗑️", name: "Мусорщик", desc: "Забери стопку из 25+ карт", c: "bigtake", n: 1, t: "g" },
  { id: "phoenix", icon: "🦅", name: "Феникс", desc: "Выйди первым, взяв за партию 15+ карт", c: "phoenix", n: 1, t: "g" },
  { id: "sniper", icon: "🎯", name: "Снайпер вслепую", desc: "50 закрытых карт подошли", c: "blindok", n: 50, t: "b" },
  { id: "mirror", icon: "🪞", name: "Зеркальщик", desc: "Положи 30 восьмёрок на восьмёрки", c: "g8", n: 30, t: "s" },
  { id: "blitz", icon: "⚡", name: "Молниеносный", desc: "Выйди первым в блице 10 раз", c: "blitzwin", n: 10, t: "b" },
  { id: "social", icon: "🤝", name: "Душа компании", desc: "Сыграй с 10 разными друзьями", c: "friends", n: 10, t: "g" },
  { id: "games100", icon: "💯", name: "Сотка", desc: "Сыграй 100 партий", c: "games", n: 100, t: "s" },
  { id: "games1000", icon: "🏛️", name: "Тысячник", desc: "Сыграй 1000 партий", c: "games", n: 1000, t: "g" },
  { id: "wins50", icon: "🏆", name: "Победитель", desc: "Выйди первым 50 раз", c: "wins", n: 50, t: "s" },
  { id: "fool25", icon: "🤡", name: "Дурак года", desc: "Побудь дураком 25 раз", c: "fools", n: 25, t: "b" },
  { id: "clean10", icon: "🧼", name: "Чистюля", desc: "Выйди первым 10 раз, ни разу не взяв стопку", c: "clean", n: 10, t: "s" },
  { id: "row5", icon: "📈", name: "Неудержимый", desc: "Выйди первым 5 партий подряд", c: "winrow", n: 5, t: "g", max: true },
  { id: "collector", icon: "🖼️", name: "Коллекционер", desc: "Собери 15 фонов и колод", c: "owned", n: 15, t: "s", max: true },
  { id: "loyal", icon: "📅", name: "Верный", desc: "Собери серию входов на 7 дней", c: "streak7", n: 1, t: "s" },
  { id: "quests30", icon: "📜", name: "Исполнительный", desc: "Выполни 30 заданий дня", c: "quests", n: 30, t: "s" },
  { id: "tower", icon: "🐉", name: "Покоритель башни", desc: "Пройди 10 этажей в Китайских играх", c: "cgwins", n: 10, t: "s" },
  { id: "highroller", icon: "🎰", name: "Хайроллер", desc: "Выиграй $1000 за один раз в казино", c: "bigcasino", n: 1, t: "g" },
  { id: "horsemen", icon: "🃏", name: "Четыре всадника", desc: "Сожги стопку четырьмя двойками", c: "four2", n: 1, t: "x" },
  { id: "eights", icon: "🎱", name: "Восьмёрочный ад", desc: "Сожги стопку четырьмя восьмёрками", c: "four8", n: 1, t: "x" },
  { id: "night", icon: "🌙", name: "Ночная смена", desc: "Доиграй партию между 3 и 5 утра", c: "night", n: 1, t: "x" },
  { id: "unlucky", icon: "🌧️", name: "Невезучий", desc: "Побудь дураком 3 партии подряд", c: "foolrow", n: 3, t: "x", max: true },
];
const ACH_COINS = { b: 20, s: 50, g: 100, x: 75 };

/* ---------- сезоны ---------- */
const SEASON_DAYS = 30, EPOCH = Date.UTC(2026, 10, 8, 21, 0, 0); // 9 ноября 2026, полночь по Москве
const SEASON_NAMES = ["Год Дракона", "Нефритовый тигр", "Огненный феникс", "Лунный кролик", "Чёрная черепаха", "Золотая змея"];
const SEASON_ICONS = ["🐉", "🐯", "🦚", "🐇", "🐢", "🐍"];
const STEP = 100, STEPS = 30;
const SP = { game: 10, win: 25, quest: 30, ach: 50 };
const seasonNow = (ts = Date.now()) => Math.max(1, Math.floor((ts - EPOCH) / (SEASON_DAYS * 864e5)) + 1);
const seasonEnd = s => EPOCH + s * SEASON_DAYS * 864e5;
function stepReward(n, season) {
  if (n === STEPS) return { frame: "frame:s" + ((season - 1) % SEASON_NAMES.length + 1), label: "рамка" };
  if (n === 20) return { chest: "big", label: "сундук" };
  if (n === 10) return { chest: "mini", label: "сундук" };
  if (n % 5 === 0) return { coins: 50, label: "$50" };
  return { coins: 10 + n, label: "$" + (10 + n) };
}
// сезонные рамки: только с дорожки сезона, купить нельзя
const SEASON_FRAMES = SEASON_NAMES.map((nm, i) => ({ id: "frame:s" + (i + 1), type: "frame", key: "s" + (i + 1), name: `Рамка «${nm}»`, price: 0, season: i + 1 }));
const LEVEL_TITLES = [[10, "Шулер"], [20, "Ветеран стола"], [30, "Гроссмейстер"], [40, "Легенда"], [50, "Император"]].map(([l, nm]) => ({ id: "title:lv" + l, type: "title", key: nm, name: nm, price: 0, lvl: l }));

module.exports = function createProgress({ data, save, SHOP, giveCoins, sendTo, openChest, displayName, avatarUrl, isFriend }) {
  const P = u => { const p = (u.prog = u.prog || {}); p.xp = p.xp || 0; p.lvl = p.lvl || 1; p.c = p.c || {}; p.got = p.got || {}; return p; };

  function grantItem(tg, id) { const u = data.users[tg]; SHOP.ensureEco(u); if (!u.owned.includes(id)) u.owned.push(id); }

  /* ----- опыт ----- */
  function addXp(tg, amount, why, practice) {
    const u = data.users[tg]; if (!u || amount <= 0) return;
    const p = P(u);
    if (practice) { const day = SHOP.today(); if (p.pday !== day) { p.pday = day; p.pxp = 0; } amount = Math.min(amount, PRACTICE_XP_CAP - p.pxp); if (amount <= 0) return; p.pxp += amount; }
    p.xp += amount;
    const ups = [];
    while (p.xp >= need(p.lvl)) { p.xp -= need(p.lvl); p.lvl++; ups.push(p.lvl); }
    save();
    for (const l of ups) {
      const r = levelReward(l), out = { level: l, rank: rankOf(l) };
      if (r.coins) { giveCoins(tg, r.coins, `Уровень ${l}`); out.coins = r.coins; }
      if (r.title) { grantItem(tg, r.title); out.title = SHOP.BY_ID[r.title].name; save(); }
      if (r.chest) out.chest = openChest(tg, r.chest);
      sendTo(tg, { t: "levelUp", ...out });
    }
    push(tg);
  }

  /* ----- сезон ----- */
  function S(u) { const s = seasonNow(); const p = P(u); if (!p.season || p.season.id !== s) p.season = { id: s, pts: 0 }; return p.season; }
  function addSp(tg, amount) {
    const u = data.users[tg]; if (!u) return;
    const s = S(u), before = Math.min(STEPS, Math.floor(s.pts / STEP));
    s.pts += amount; const after = Math.min(STEPS, Math.floor(s.pts / STEP)); save();
    for (let n = before + 1; n <= after; n++) {
      const r = stepReward(n, s.id);
      if (r.coins) giveCoins(tg, r.coins, `Сезон: ступень ${n}`);
      if (r.chest) sendTo(tg, { t: "chestOpen", src: "season", ...openChest(tg, r.chest) });
      if (r.frame) { grantItem(tg, r.frame); save(); sendTo(tg, { t: "toast", msg: `Сезон пройден! ${SHOP.BY_ID[r.frame].name} теперь твоя` }); }
    }
  }
  // итоги прошлого сезона: топ-3 получают корону до конца следующего
  function crowns() {
    const cur = seasonNow(); data.seasonTop = data.seasonTop || {};
    const prev = cur - 1;
    if (prev >= 1 && !data.seasonTop[prev]) {
      const rows = Object.entries(data.users).filter(([, u]) => u.prog && u.prog.season && u.prog.season.id === prev && u.prog.season.pts > 0)
        .sort((a, b) => b[1].prog.season.pts - a[1].prog.season.pts).slice(0, 3).map(([id]) => id);
      data.seasonTop[prev] = rows; save();
    }
    return data.seasonTop[prev] || [];
  }
  const crownOf = tg => { const i = crowns().indexOf(String(tg)); return i >= 0 ? i + 1 : 0; };
  function top(n = 10) {
    const s = seasonNow();
    return Object.entries(data.users).filter(([, u]) => u.prog && u.prog.season && u.prog.season.id === s && u.prog.season.pts > 0)
      .sort((a, b) => b[1].prog.season.pts - a[1].prog.season.pts);
  }

  /* ----- достижения ----- */
  function count(tg, key, by = 1, set) {
    const u = data.users[tg]; if (!u) return; const p = P(u);
    p.c[key] = set != null ? (ACH.some(a => a.c === key && a.max) ? Math.max(p.c[key] || 0, set) : set) : (p.c[key] || 0) + by;
    for (const a of ACH) if (a.c === key && !p.got[a.id] && (p.c[key] || 0) >= a.n) {
      p.got[a.id] = Date.now(); save();
      giveCoins(tg, ACH_COINS[a.t], `Достижение «${a.name}»`);
      sendTo(tg, { t: "achGot", id: a.id, icon: a.icon, name: a.name, desc: a.desc, tier: a.t, coins: ACH_COINS[a.t] });
      addXp(tg, XP.ach, "ach"); addSp(tg, SP.ach);
    }
    save();
  }

  /* ----- события партии (от правил) ----- */
  const tgOf = pid => pid && pid.startsWith("tg") ? pid.slice(2) : null;
  function ev(type, st, pid, info = {}) {
    try {
      const tg = tgOf(pid);
      if (type === "burn" && tg) {
        count(tg, "burns");
        if (info.by === "four") { const r = (st.pile[st.pile.length - 1] || "").slice(0, -1); if (r === "2") count(tg, "four2"); if (r === "8") count(tg, "four8"); }
        const u = data.users[tg]; if (u) { const p = P(u), day = SHOP.today(); if (p.bday !== day) { p.bday = day; p.bxp = 0; } if (p.bxp < BURN_XP_CAP) { p.bxp += XP.burn; addXp(tg, XP.burn, "burn", st.practice); } }
      } else if (type === "play" && tg) {
        if (info.blind) count(tg, "blindok");
        if (info.r === "8" && (info.prevLit === "8" || info.n >= 2)) count(tg, "g8", info.prevLit === "8" ? info.n : info.n - 1);
      } else if (type === "take" && tg) {
        if (info.n >= 25) count(tg, "bigtake");
      }
    } catch (e) { console.error("progress ev", e); }
  }
  // конец партии: опыт, очки сезона, счётчики
  function gameOver(st, cg) {
    try {
      const humans = st.players.filter(p => tgOf(p.id) && data.users[tgOf(p.id)]);
      const online = humans.length >= 2;
      if (!st.practice && !online) return;
      const msk = new Date(Date.now() + 3 * 3600e3).getUTCHours();
      for (const p of humans) {
        const tg = tgOf(p.id), u = data.users[tg], pr = P(u), g = (st.qg || {})[p.id] || {};
        const place = st.finished.indexOf(p.id), first = place === 0, fool = st.loser === p.id;
        let xp = XP.game + (first ? XP.first : !fool ? XP.middle : 0);
        addXp(tg, xp, "game", st.practice);
        addSp(tg, SP.game + (first ? SP.win : 0));
        count(tg, "games");
        if (first) {
          count(tg, "wins"); pr.c.wr = (pr.c.wr || 0) + 1; count(tg, "winrow", 0, pr.c.wr);
          if (!g.took) count(tg, "clean");
          if (g.maxH >= 15) count(tg, "phoenix");
          if (st.mode === "blitz") count(tg, "blitzwin");
          if (cg) count(tg, "cgwins");
        } else pr.c.wr = 0;
        if (fool) { count(tg, "fools"); pr.c.fr = (pr.c.fr || 0) + 1; count(tg, "foolrow", 0, pr.c.fr); } else pr.c.fr = 0;
        if (msk >= 3 && msk < 5) count(tg, "night");
        if (online && isFriend) {
          pr.fset = pr.fset || [];
          for (const o of humans) { const ot = tgOf(o.id); if (ot !== tg && isFriend(tg, ot) && !pr.fset.includes(ot)) pr.fset.push(ot); }
          count(tg, "friends", 0, pr.fset.length);
        }
      }
      save();
      for (const p of humans) push(tgOf(p.id));
    } catch (e) { console.error("progress over", e); }
  }
  function questDone(tg) { addXp(tg, XP.quest, "quest"); addSp(tg, SP.quest); count(tg, "quests"); }
  function streak(tg, n) { if (n >= 7) count(tg, "streak7"); }
  function casinoWin(tg, win) { if (win >= 1000) count(tg, "bigcasino"); }
  function owned(tg) { const u = data.users[tg]; if (!u) return; SHOP.ensureEco(u); count(tg, "owned", 0, u.owned.filter(id => /^(bg|deck):/.test(id)).length); }

  function view(tg) {
    const u = data.users[tg]; if (!u) return null; const p = P(u), s = S(u);
    const road = []; for (let l = Math.max(2, p.lvl - 2); l <= p.lvl + 10; l++) { const r = levelReward(l); road.push({ l, kind: r.title ? "title" : r.chest ? "chest" : "coins", label: r.title ? SHOP.BY_ID[r.title].name : r.chest ? "сундук" : "$" + r.coins }); }
    const rows = top(), myIdx = rows.findIndex(([id]) => id === String(tg));
    const si = (s.id - 1) % SEASON_NAMES.length;
    return {
      level: p.lvl, xp: p.xp, need: need(p.lvl), rank: rankOf(p.lvl), road, xpTable: XP,
      ach: ACH.map(a => { const got = !!p.got[a.id]; const prog = Math.min(a.n, p.c[a.c] || 0); return { id: a.id, icon: a.t === "x" && !got ? "❓" : a.icon, name: a.t === "x" && !got ? "???" : a.name, desc: a.t === "x" && !got ? "Тайное достижение" : a.desc, tier: a.t, n: a.n, p: prog, got, coins: ACH_COINS[a.t] }; }),
      season: { id: s.id, name: SEASON_NAMES[si], icon: SEASON_ICONS[si], pts: s.pts, step: Math.min(STEPS, Math.floor(s.pts / STEP)), stepPts: STEP, steps: Array.from({ length: STEPS }, (_, i) => { const r = stepReward(i + 1, s.id); return { n: i + 1, kind: r.frame ? "frame" : r.chest ? "chest" : "coins", label: r.label, frame: r.frame ? SHOP.BY_ID[r.frame].key : null }; }),
        endsAt: seasonEnd(s.id), left: seasonEnd(s.id) - Date.now(), sp: SP,
        top: rows.slice(0, 10).map(([id, x], i) => ({ i: i + 1, name: displayName(x), avatar: avatarUrl(id), pts: x.prog.season.pts, me: id === String(tg) })),
        me: myIdx >= 0 ? { i: myIdx + 1, pts: s.pts } : null },
    };
  }
  function push(tg) { const v = view(tg); if (v) sendTo(tg, { t: "progress", ...v }); }
  const levelOf = tg => { const u = data.users[tg]; return u && u.prog ? u.prog.lvl || 1 : 1; };

  return { view, push, ev, gameOver, questDone, streak, casinoWin, owned, addXp, crownOf, levelOf, _ACH: ACH };
};
module.exports.EXTRA_ITEMS = [...LEVEL_TITLES, ...SEASON_FRAMES];
module.exports.need = need;
