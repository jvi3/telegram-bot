// Магазин и экономика (by Кащей). Только внешний вид — на силу в игре ничего не влияет.
"use strict";

const ECONOMY = {
  start: 20,      // стартовый баланс
  win: 10,        // вышел первым
  middle: 3,      // средние места (при 3+ игроках)
  fool: -2,       // дурак (баланс не уходит в минус)
  daily: 5,       // ежедневный бонус
  practiceWin: 2, // победа в тренировке с ботами
  practiceCap: 5, // сколько тренировочных наград в день
};

// type: bg | deck | color | title | reacts | winfx
const ITEMS = [
  { id: "bg:felt", type: "bg", key: "felt", name: "Сукно", price: 0 },
  { id: "bg:classic", type: "bg", key: "classic", name: "Классический стол", price: 0 },
  { id: "bg:stars", type: "bg", key: "stars", name: "Звёздное небо", price: 20 },
  { id: "bg:city", type: "bg", key: "city", name: "Ночной город", price: 30 },
  { id: "bg:tavern", type: "bg", key: "tavern", name: "Таверна", price: 30 },
  { id: "bg:dungeon", type: "bg", key: "dungeon", name: "Подземелье", price: 40 },
  { id: "bg:snow", type: "bg", key: "snow", name: "Зимняя ночь", price: 40 },
  { id: "bg:sunset", type: "bg", key: "sunset", name: "Пиксельный закат", price: 60 },
  { id: "bg:swirl", type: "bg", key: "swirl", name: "Психоделика", price: 75 },

  { id: "deck:classic", type: "deck", key: "classic", name: "Классика", price: 0 },
  { id: "deck:vintage", type: "deck", key: "vintage", name: "Винтаж", price: 25 },
  { id: "deck:pixel", type: "deck", key: "pixel", name: "8-бит", price: 35 },
  { id: "deck:noir", type: "deck", key: "noir", name: "Нуар", price: 40 },
  { id: "deck:royal", type: "deck", key: "royal", name: "Королевская", price: 60 },

  { id: "color:gold", type: "color", key: "#f2c14e", name: "Золото", price: 0 },
  { id: "color:mint", type: "color", key: "#7ee0b5", name: "Мята", price: 0 },
  { id: "color:sky", type: "color", key: "#7cc4ff", name: "Небо", price: 0 },
  { id: "color:coral", type: "color", key: "#ff8b7b", name: "Коралл", price: 15 },
  { id: "color:lavender", type: "color", key: "#b9a4ff", name: "Лаванда", price: 15 },
  { id: "color:lime", type: "color", key: "#c7e86a", name: "Лайм", price: 15 },

  { id: "title:none", type: "title", key: "", name: "Без титула", price: 0 },
  { id: "title:torn", type: "title", key: "Порванный туз", name: "Порванный туз", price: 30 },
  { id: "title:six", type: "title", key: "Шестёрка", name: "Шестёрка", price: 45 },
  { id: "title:boss", type: "title", key: "Карточный босс", name: "Карточный босс", price: 100 },
  { id: "title:goldace", type: "title", key: "Золотой туз", name: "Золотой туз", price: 250 },

  { id: "reacts:basic", type: "reacts", key: "👍😂", emojis: ["👍", "😂"], name: "Базовые", price: 0, always: true },
  { id: "reacts:spicy", type: "reacts", key: "😡🔥🤡", emojis: ["😡", "🔥", "🤡"], name: "Дерзкие", price: 20, always: true },
  { id: "reacts:royal", type: "reacts", key: "👑💀😎", emojis: ["👑", "💀", "😎"], name: "Королевские", price: 40, always: true },

  { id: "winfx:fireworks", type: "winfx", key: "fireworks", name: "Фейерверк", price: 0 },
  { id: "winfx:confetti", type: "winfx", key: "confetti", name: "Конфетти", price: 20 },
  { id: "winfx:coins", type: "winfx", key: "coins", name: "Золотой дождь", price: 50 },
];
const BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const DEFAULT_EQUIP = { bg: "bg:felt", deck: "deck:classic", color: "color:gold", title: "title:none", winfx: "winfx:fireworks" };
const COLOR_ORDER = ITEMS.filter(i => i.type === "color").map(i => i.key);

const today = () => new Date().toISOString().slice(0, 10);

function ensureEco(u) {
  if (typeof u.coins !== "number") u.coins = ECONOMY.start;
  if (!Array.isArray(u.owned)) u.owned = [];
  if (!u.equipped || typeof u.equipped !== "object") u.equipped = {};
  for (const [k, v] of Object.entries(DEFAULT_EQUIP)) if (!BY_ID[u.equipped[k]]) u.equipped[k] = v;
  return u;
}
const owns = (u, id) => { const it = BY_ID[id]; return !!it && (it.price === 0 || u.owned.includes(id)); };

function profile(u) {
  ensureEco(u);
  const reacts = ITEMS.filter(i => i.type === "reacts" && owns(u, i.id)).flatMap(i => i.emojis);
  return { coins: u.coins, owned: u.owned, equipped: u.equipped, reacts, dailyReady: u.daily !== today() };
}

function buy(u, id) {
  ensureEco(u);
  const it = BY_ID[id];
  if (!it) return "Такого товара нет";
  if (owns(u, id)) return "Уже куплено";
  if (u.coins < it.price) return `Не хватает $${it.price - u.coins}`;
  u.coins -= it.price;
  u.owned.push(id);
  if (it.type !== "reacts") u.equipped[it.type] = id; // купленное сразу надеваем
  return null;
}
function equip(u, id) {
  ensureEco(u);
  const it = BY_ID[id];
  if (!it || it.type === "reacts") return "Это нельзя надеть";
  if (!owns(u, id)) return "Сначала купи в магазине";
  u.equipped[it.type] = id;
  return null;
}
function claimDaily(u) {
  ensureEco(u);
  if (u.daily === today()) return "Бонус уже получен сегодня, приходи завтра";
  u.daily = today();
  u.coins += ECONOMY.daily;
  return null;
}
function canReact(u, emoji) { return profile(u).reacts.includes(emoji); }

// Промокоды: data.promos = { КОД: { amount, limit, used: [tgId...], created } }
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9А-ЯЁ_-]/g, "").slice(0, 24);
function createPromo(data, code, amount, limit) {
  code = normCode(code);
  if (!code || code.length < 3) return "Код — от 3 символов: буквы, цифры, _ или -";
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return "Сумма — целое число от 1 до 100000";
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000000) return "Лимит — целое число (0 = без лимита)";
  data.promos = data.promos || {};
  if (data.promos[code]) return "Такой код уже есть";
  data.promos[code] = { amount, limit, used: [], created: Date.now() };
  return null;
}
function redeemPromo(data, tgId, code) {
  code = normCode(code);
  const p = (data.promos || {})[code];
  if (!p) return { err: "Такого промокода нет" };
  if (p.used.includes(String(tgId))) return { err: "Ты уже активировал этот промокод" };
  if (p.limit && p.used.length >= p.limit) return { err: "Промокод закончился" };
  p.used.push(String(tgId));
  return { amount: p.amount, code };
}

module.exports = { ECONOMY, ITEMS, BY_ID, COLOR_ORDER, ensureEco, profile, buy, equip, claimDaily, canReact, today, createPromo, redeemPromo, normCode };
