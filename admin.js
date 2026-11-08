// Админ-панель бота (by Кащей). Открывается командой /admin, видна только админам из ADMIN_IDS.
"use strict";

const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtAgo(ts) {
  if (!ts) return "—";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}
function fmtUptime(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} дн ${h % 24} ч`;
  if (h) return `${h} ч ${m % 60} мин`;
  return `${m} мин`;
}
const STATUS = { lobby: "ждут игроков", swap: "меняют карты", play: "играют", over: "партия окончена" };

module.exports = function createAdmin(ctx) {
  const { tg, rooms, data, save, adminIds, kickUser, closeRoom, onlineIds, startedAt } = ctx;
  const pending = new Map(); // chatId -> {type:"bc"} | {type:"bcReady", text} | {type:"ban"}

  const isAdmin = uid => adminIds.includes(String(uid));
  const kb = rows => ({ inline_keyboard: rows });
  const back = [{ text: "« Назад в меню", callback_data: "a:home" }];

  function home() {
    return {
      text: `<b>🛠 Админ-панель</b>\n\nТехработы: ${data.maintenance ? "🔴 включены" : "🟢 выключены"}`,
      markup: kb([
        [{ text: "📊 Статистика", callback_data: "a:stats" }, { text: "🃏 Комнаты", callback_data: "a:rooms" }],
        [{ text: "👥 Игроки", callback_data: "a:users" }, { text: "🚫 Баны", callback_data: "a:bans" }],
        [{ text: "📣 Рассылка", callback_data: "a:bc" }],
        [{ text: data.maintenance ? "🟢 Выключить техработы" : "🔴 Включить техработы", callback_data: "a:maint" }],
      ]),
    };
  }

  function stats() {
    const users = Object.values(data.users);
    const dayAgo = Date.now() - 86400e3;
    const live = [...rooms.values()].filter(r => !r.st.practice);
    const playing = live.filter(r => r.st.status === "play" || r.st.status === "swap").length;
    const practice = [...rooms.values()].filter(r => r.st.practice).length;
    return {
      text: [
        "<b>📊 Статистика</b>", "",
        `Игроков всего: <b>${users.length}</b>`,
        `Новых за сутки: <b>${users.filter(u => u.first > dayAgo).length}</b>`,
        `Заходили за сутки: <b>${users.filter(u => u.last > dayAgo).length}</b>`,
        `Сейчас в игре: <b>${onlineIds().size}</b>`, "",
        `Комнат с друзьями: <b>${live.length}</b> (идёт партий: ${playing})`,
        `Тренировок с ботами: <b>${practice}</b>`,
        `Сыграно партий всего: <b>${data.stats.games}</b>`, "",
        `В бане: <b>${data.banned.length}</b>`,
        `Сервер работает: ${fmtUptime(Date.now() - startedAt)}`,
      ].join("\n"),
      markup: kb([[{ text: "🔄 Обновить", callback_data: "a:stats" }], back]),
    };
  }

  function roomsView() {
    const list = [...rooms.values()].filter(r => !r.st.practice).sort((a, b) => b.st.updated - a.st.updated).slice(0, 15);
    if (!list.length) return { text: "<b>🃏 Комнаты</b>\n\nСейчас открытых комнат нет.", markup: kb([[{ text: "🔄 Обновить", callback_data: "a:rooms" }], back]) };
    const lines = list.map(r => `<b>${r.st.code}</b> · ${STATUS[r.st.status] || r.st.status} · ${fmtAgo(r.st.updated)}\n   ${r.st.players.map(p => esc(p.name)).join(", ")}`);
    const rows = list.map(r => [{ text: `❌ Закрыть ${r.st.code}`, callback_data: `a:close:${r.st.code}` }]);
    return { text: `<b>🃏 Комнаты</b> (${list.length})\n\n${lines.join("\n\n")}`, markup: kb([...rows, [{ text: "🔄 Обновить", callback_data: "a:rooms" }], back]) };
  }

  function usersView() {
    const list = Object.entries(data.users).sort((a, b) => b[1].last - a[1].last).slice(0, 20);
    if (!list.length) return { text: "<b>👥 Игроки</b>\n\nПока никого.", markup: kb([back]) };
    const on = onlineIds();
    const lines = list.map(([id, u]) =>
      `${on.has(id) ? "🟢" : "⚪️"} ${esc(u.name)}${u.username ? " @" + esc(u.username) : ""}\n   ID <code>${id}</code> · партий ${u.games || 0} · ${fmtAgo(u.last)}${data.banned.includes(id) ? " · 🚫" : ""}`);
    return {
      text: `<b>👥 Последние игроки</b>\n\n${lines.join("\n")}\n\nЧтобы забанить, нажми «🚫 Баны» и пришли ID.`,
      markup: kb([[{ text: "🔄 Обновить", callback_data: "a:users" }], back]),
    };
  }

  function bansView() {
    const rows = data.banned.slice(0, 20).map(id => {
      const u = data.users[id];
      return [{ text: `✅ Разбанить ${u ? u.name : id}`, callback_data: `a:unban:${id}` }];
    });
    return {
      text: `<b>🚫 Баны</b>\n\n${data.banned.length ? `В бане: ${data.banned.length}` : "Никто не забанен."}\n\nЧтобы забанить, нажми кнопку ниже и пришли ID игрока (его видно в «👥 Игроки»). Или команда <code>/ban ID</code>.`,
      markup: kb([...rows, [{ text: "➕ Забанить игрока", callback_data: "a:banask" }], back]),
    };
  }

  async function show(chatId, view, messageId) {
    const body = { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.markup, disable_web_page_preview: true };
    if (messageId) {
      const r = await tg("editMessageText", { ...body, message_id: messageId });
      if (r) return;
    }
    await tg("sendMessage", body);
  }

  function ban(id, chatId) {
    id = String(id).replace(/\D/g, "");
    if (!id) return tg("sendMessage", { chat_id: chatId, text: "Пришли числовой ID игрока." });
    if (isAdmin(id)) return tg("sendMessage", { chat_id: chatId, text: "Админа забанить нельзя." });
    if (!data.banned.includes(id)) data.banned.push(id);
    save();
    kickUser(id);
    const u = data.users[id];
    return tg("sendMessage", { chat_id: chatId, text: `🚫 ${u ? u.name : id} забанен и выкинут из игры.`, reply_markup: kb([[{ text: "« В меню", callback_data: "a:home" }]]) });
  }
  function unban(id) {
    data.banned = data.banned.filter(x => x !== String(id));
    save();
  }

  async function broadcastAll(chatId, text) {
    const ids = Object.keys(data.users).filter(id => !data.banned.includes(id));
    await tg("sendMessage", { chat_id: chatId, text: `📣 Отправляю ${ids.length} игрокам…` });
    let ok = 0, fail = 0;
    for (const id of ids) {
      const r = await tg("sendMessage", { chat_id: id, text, reply_markup: kb([[{ text: "🃏 Играть", web_app: { url: ctx.appUrl() } }]]) }, { quiet: true });
      if (r) ok++; else fail++;
      await sleep(45); // Telegram разрешает ~30 сообщений в секунду
    }
    await tg("sendMessage", { chat_id: chatId, text: `✅ Рассылка готова. Доставлено: ${ok}. Не дошло: ${fail} (заблокировали бота).`, reply_markup: kb([[{ text: "« В меню", callback_data: "a:home" }]]) });
  }

  // Сообщения от админа. true = обработано здесь.
  async function onMessage(m) {
    const uid = String(m.from && m.from.id);
    if (!isAdmin(uid)) return false;
    const text = (m.text || "").trim();
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === "/admin") { pending.delete(m.chat.id); await show(m.chat.id, home()); return true; }
    if (cmd === "/ban") { await ban(arg || "", m.chat.id); return true; }
    if (cmd === "/unban") { unban(String(arg || "").replace(/\D/g, "")); await tg("sendMessage", { chat_id: m.chat.id, text: "✅ Разбанен." }); return true; }
    const p = pending.get(m.chat.id);
    if (!p || text.startsWith("/")) return false;
    if (p.type === "bc") {
      if (text.length > 3500) { await tg("sendMessage", { chat_id: m.chat.id, text: "Слишком длинно, сократи до 3500 символов." }); return true; }
      pending.set(m.chat.id, { type: "bcReady", text });
      await tg("sendMessage", {
        chat_id: m.chat.id,
        text: `Вот так увидят игроки:\n\n${text}\n\nОтправить всем (${Object.keys(data.users).length - data.banned.length})?`,
        reply_markup: kb([[{ text: "✅ Отправить", callback_data: "a:bcok" }, { text: "❌ Отмена", callback_data: "a:bcno" }]]),
      });
      return true;
    }
    if (p.type === "ban") { pending.delete(m.chat.id); await ban(text, m.chat.id); return true; }
    return false;
  }

  async function onCallback(q) {
    const uid = String(q.from && q.from.id);
    const chatId = q.message && q.message.chat.id;
    const mid = q.message && q.message.message_id;
    if (!isAdmin(uid) || !chatId) { await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Только для админа" }); return; }
    const [, action, arg] = String(q.data || "").split(":");
    let note = "";
    switch (action) {
      case "home": pending.delete(chatId); await show(chatId, home(), mid); break;
      case "stats": await show(chatId, stats(), mid); break;
      case "rooms": await show(chatId, roomsView(), mid); break;
      case "users": await show(chatId, usersView(), mid); break;
      case "bans": await show(chatId, bansView(), mid); break;
      case "close": note = closeRoom(arg) ? `Комната ${arg} закрыта` : "Комнаты уже нет"; await show(chatId, roomsView(), mid); break;
      case "unban": unban(arg); note = "Разбанен"; await show(chatId, bansView(), mid); break;
      case "banask":
        pending.set(chatId, { type: "ban" });
        await tg("sendMessage", { chat_id: chatId, text: "Пришли ID игрока, которого забанить (числа из «👥 Игроки»).", reply_markup: kb([[{ text: "❌ Отмена", callback_data: "a:home" }]]) });
        break;
      case "maint":
        data.maintenance = !data.maintenance; save();
        note = data.maintenance ? "Техработы включены: новые игры не создаются" : "Техработы выключены";
        await show(chatId, home(), mid); break;
      case "bc":
        pending.set(chatId, { type: "bc" });
        await tg("sendMessage", { chat_id: chatId, text: "📣 Пришли текст рассылки одним сообщением. Его получат все, кто запускал бота.", reply_markup: kb([[{ text: "❌ Отмена", callback_data: "a:home" }]]) });
        break;
      case "bcok": {
        const p = pending.get(chatId);
        pending.delete(chatId);
        if (p && p.type === "bcReady") broadcastAll(chatId, p.text).catch(e => console.error(e));
        else note = "Текст рассылки потерялся, начни заново";
        break;
      }
      case "bcno": pending.delete(chatId); note = "Рассылка отменена"; await show(chatId, home(), mid); break;
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: note || undefined });
  }

  return { isAdmin, onMessage, onCallback };
};
