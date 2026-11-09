// Профиль игрока: статус, витрина медалей, статистика, последние партии, любимая карта и «карта-преследователь».
"use strict";

const RANK_NAME = { "3": "Тройка", "4": "Четвёрка", "5": "Пятёрка", "6": "Шестёрка", "7": "Семёрка", "8": "Восьмёрка", "9": "Девятка", "10": "Десятка", J: "Валет", Q: "Дама", K: "Король", A: "Туз", "2": "Двойка" };
const STALKER = {
  "3": "Мелочь, которая любит тебя больше всех",
  "4": "Четвёрка-прилипала: не отстаёт ни на шаг",
  "5": "Серая лошадка твоей руки",
  "6": "Шестёрка на побегушках — всегда рядом",
  "7": "Семёрка решила, что вы семья",
  "8": "Прозрачно намекает, что ты особенный",
  "9": "Девятка ходит за тобой хвостом",
  "10": "Огонь сам тебя находит",
  J: "Валет — твой личный сталкер",
  Q: "Дама сердца. Буквально",
  K: "Король, который выбрал тебя",
  A: "Туз в рукаве — всегда твой",
  "2": "Двойки липнут к везунчикам",
};
const rk = c => c.slice(0, -1);

module.exports = function createProfile({ data, save, SHOP, progress, displayName, avatarUrl, friendStatus }) {
  const PS = u => { const p = (u.pst = u.pst || {}); p.cards = p.cards || {}; p.burnR = p.burnR || {}; p.h2h = p.h2h || {}; p.hist = p.hist || ""; p.show = p.show || []; return p; };
  const tgOf = pid => pid && pid.startsWith("tg") ? pid.slice(2) : null;
  let dirty = false; const touch = () => { if (!dirty) { dirty = true; setTimeout(() => { dirty = false; save(); }, 2000); } };

  function ev(type, st, pid, info = {}) {
    try {
      const tg = tgOf(pid), u = tg && data.users[tg]; if (!u) return;
      const p = PS(u);
      if (type === "deal" || type === "draw") { for (const c of info.cards || []) p.cards[c] = (p.cards[c] || 0) + 1; touch(); }
      else if (type === "burn") { const r = info.by === "10" ? "10" : rk(st.pile[st.pile.length - 1] || "10"); p.burnR[r] = (p.burnR[r] || 0) + 1; touch(); }
      else if (type === "take") { if (info.n > (p.maxTake || 0)) { p.maxTake = info.n; touch(); } }
    } catch (e) { console.error("profile ev", e); }
  }
  // результат партии: история и личные счёты между живыми игроками
  function gameOver(st) {
    try {
      const humans = st.players.filter(p => tgOf(p.id) && data.users[tgOf(p.id)]);
      if (!st.practice && humans.length < 2) return;
      const place = pid => { const i = st.finished.indexOf(pid); return i >= 0 ? i : st.loser === pid ? 99 : 50; };
      for (const p of humans) {
        const tg = tgOf(p.id), ps = PS(data.users[tg]);
        const mark = st.finished[0] === p.id ? "1" : st.loser === p.id ? "Д" : "✓";
        ps.hist = (mark + ps.hist).slice(0, 15);
        if (humans.length >= 2) for (const o of humans) { if (o === p) continue; const ot = tgOf(o.id), h = ps.h2h[ot] || (ps.h2h[ot] = [0, 0]); if (place(p.id) < place(o.id)) h[0]++; else h[1]++; }
      }
      save();
    } catch (e) { console.error("profile over", e); }
  }
  function casinoWin(tg, win) { const u = data.users[tg]; if (!u) return; const p = PS(u); if (win > (p.bestCas || 0)) { p.bestCas = win; touch(); } }

  function setStatus(tg, text) {
    const u = data.users[tg]; if (!u) return "Нет профиля";
    const t = String(text || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    PS(u).status = t; save(); return null;
  }
  function setShowcase(tg, ids) {
    const u = data.users[tg]; if (!u) return "Нет профиля";
    const got = (u.prog && u.prog.got) || {};
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((id, i, a) => got[id] && a.indexOf(id) === i).slice(0, 3);
    PS(u).show = list; save(); return null;
  }

  function topOf(obj) { let best = null, n = 0; for (const [k, v] of Object.entries(obj)) if (v > n) { best = k; n = v; } return best ? { key: best, n } : null; }
  function view(tg, viewer) {
    const u = data.users[tg]; if (!u) return null;
    SHOP.ensureEco(u); const p = PS(u), pr = (u.prog || {}), c = pr.c || {};
    const ACH = progress._ACH, byId = Object.fromEntries(ACH.map(a => [a.id, a]));
    const games = Math.max(c.games || 0, u.games || 0), wins = Math.max(c.wins || 0, u.wins || 0), fools = Math.max(c.fools || 0, u.fools || 0);
    const total = Object.values(p.cards).reduce((a, b) => a + b, 0);
    const st = total >= 27 ? topOf(p.cards) : null, fav = topOf(p.burnR);
    const coll = t => ({ have: u.owned.filter(id => id.startsWith(t + ":") && SHOP.BY_ID[id] && SHOP.BY_ID[id].price > 0).length, all: SHOP.ITEMS.filter(i => i.type === t && i.price > 0).length });
    const me = String(tg) === String(viewer);
    const fr = viewer && data.users[viewer] && (data.users[viewer].friends || []).includes(String(tg));
    const h = !me && viewer ? (p.h2h[viewer] || null) : null;
    return {
      id: String(tg), me, name: displayName(u), avatar: avatarUrl(tg),
      color: (SHOP.BY_ID[u.equipped.color] || {}).key || "#f2c14e", frame: (SHOP.BY_ID[u.equipped.frame] || {}).key || "", title: (SHOP.BY_ID[u.equipped.title] || {}).key || "",
      level: pr.lvl || 1, crown: progress.crownOf(tg), status: p.status || "",
      show: p.show.filter(id => pr.got && pr.got[id] && byId[id]).map(id => ({ id, icon: byId[id].icon, name: byId[id].name, tier: byId[id].t })),
      achGot: Object.keys(pr.got || {}).length, achAll: ACH.length,
      stats: { games, wins, fools, burns: c.burns || 0, maxTake: p.maxTake || 0, bestCas: p.bestCas || 0, wr: games ? Math.round(wins / games * 100) : 0 },
      hist: p.hist,
      fav: fav ? { rank: fav.key, name: RANK_NAME[fav.key], n: fav.n } : null,
      stalker: st ? { card: st.key, name: RANK_NAME[rk(st.key)], n: st.n, joke: STALKER[rk(st.key)] } : null,
      coll: { bg: coll("bg"), deck: coll("deck") },
      ...(me ? { gotList: ACH.filter(a => pr.got && pr.got[a.id]).map(a => ({ id: a.id, icon: a.icon, name: a.name, tier: a.t })) } : { online: friendStatus(String(tg)).status, friend: !!fr, h2h: h }),
    };
  }
  return { ev, gameOver, casinoWin, setStatus, setShowcase, view };
};
