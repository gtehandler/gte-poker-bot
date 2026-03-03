require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const Redis = require("ioredis");

/* ── Config ── */
const BOT_TOKEN = process.env.BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "").split(",").map(Number).filter(Boolean);
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || "";

if (!BOT_TOKEN) { console.error("BOT_TOKEN required"); process.exit(1); }
if (!REDIS_URL) { console.error("REDIS_URL required"); process.exit(1); }

/* ── Redis ── */
const redisOpts = {};
if (REDIS_URL.startsWith("rediss://")) redisOpts.tls = { rejectUnauthorized: false };
const redis = new Redis(REDIS_URL, redisOpts);
redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("Redis connected"));

/* ── Helpers ── */
function totalIn(r) { return r.buyIn * (1 + r.rebuys); }
function pl(r) { return r.cashOut - totalIn(r); }
function fmt(n) { return n >= 0 ? `+$${n.toLocaleString()}` : `-$${Math.abs(n).toLocaleString()}`; }

async function getData() {
  const [sessions, results, players, counters, nextGame] = await Promise.all([
    redis.get("gte:sessions"),
    redis.get("gte:results"),
    redis.get("gte:players"),
    redis.get("gte:counters"),
    redis.get("gte:nextgame"),
  ]);
  return {
    sessions: sessions ? JSON.parse(sessions) : [],
    results: results ? JSON.parse(results) : [],
    players: players ? JSON.parse(players) : [],
    counters: counters ? JSON.parse(counters) : { nextSId: 1, nextRId: 1, nextPId: 1 },
    nextGame: nextGame ? JSON.parse(nextGame) : null,
  };
}

async function saveData(data) {
  const ops = [
    redis.set("gte:sessions", JSON.stringify(data.sessions)),
    redis.set("gte:results", JSON.stringify(data.results)),
    redis.set("gte:players", JSON.stringify(data.players)),
    redis.set("gte:counters", JSON.stringify(data.counters)),
  ];
  if (data.nextGame !== undefined) ops.push(redis.set("gte:nextgame", JSON.stringify(data.nextGame)));
  await Promise.all(ops);
}

function dn(player, players) {
  const p = players.find((x) => x.name === player);
  const av = p?.avatar || "\u{1F3AD}";
  const nick = p?.nickname;
  return nick ? `${av} ${player} "${nick}"` : `${av} ${player}`;
}

function settle(rows) {
  const net = {};
  rows.forEach((r) => { net[r.player] = (net[r.player] || 0) + pl(r); });
  const debtors = [], creditors = [];
  Object.entries(net).forEach(([p, v]) => {
    if (v < 0) debtors.push({ player: p, amount: -v });
    else if (v > 0) creditors.push({ player: p, amount: v });
  });
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);
  const txns = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].amount, creditors[j].amount);
    if (amt > 0.01) txns.push({ from: debtors[i].player, to: creditors[j].player, amount: Math.round(amt * 100) / 100 });
    debtors[i].amount -= amt;
    creditors[j].amount -= amt;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return { txns, net };
}

/* ── Bot ── */
const bot = new Telegraf(BOT_TOKEN);

/* ── Auth middleware ── */
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    return ctx.reply("\u{1F6AB} You're not on the whitelist. Ask the admin to add your Telegram user ID.");
  }
  return next();
});

/* ── Notify helper ── */
async function notify(text) {
  if (GROUP_CHAT_ID) {
    try { await bot.telegram.sendMessage(GROUP_CHAT_ID, text, { parse_mode: "HTML" }); }
    catch (e) { console.error("Group notify failed:", e.message); }
  }
}

/* ════════════════════════════════════════════
   READ-ONLY COMMANDS
   ════════════════════════════════════════════ */

bot.command("start", (ctx) => {
  ctx.reply(
    `\u{1F3B0} *GTE Poker Bot*\n\n` +
    `*Read Commands:*\n` +
    `/lb — Leaderboard\n` +
    `/stats <player> — Player stats\n` +
    `/sessions — List sessions\n` +
    `/results <session#> — Session results\n` +
    `/settlements — All-time settlements\n` +
    `/nextgame — Next game info\n` +
    `/summary — Quick overview\n\n` +
    `*Write Commands:*\n` +
    `/newsession — Create a session\n` +
    `/addresult — Add a result\n` +
    `/delsession <#> — Delete session\n` +
    `/delresult <#> — Delete result\n` +
    `/schedule — Schedule next game\n` +
    `/cancelgame — Cancel next game\n` +
    `/rsvp — RSVP for next game\n\n` +
    `\u{1F310} [Open Web App](https://gte-poker.vercel.app)`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );
});

bot.command("lb", async (ctx) => {
  try {
    const { results, players } = await getData();
    if (results.length === 0) return ctx.reply("No results yet.");
    const map = {};
    results.forEach((r) => {
      if (!map[r.player]) map[r.player] = { player: r.player, net: 0, sessions: 0, wins: 0 };
      const n = pl(r);
      map[r.player].net += n;
      map[r.player].sessions += 1;
      if (n > 0) map[r.player].wins += 1;
    });
    const lb = Object.values(map).sort((a, b) => b.net - a.net);
    let text = "\u{1F3C6} <b>LEADERBOARD</b>\n\n";
    lb.forEach((p, i) => {
      const badge = i === 0 ? "\u{1F947}" : i === 1 ? "\u{1F948}" : i === 2 ? "\u{1F949}" : `#${i + 1}`;
      const winPct = p.sessions ? Math.round((p.wins / p.sessions) * 100) : 0;
      const color = p.net >= 0 ? "\u{1F7E2}" : "\u{1F534}";
      text += `${badge} ${dn(p.player, players)}\n   ${color} ${fmt(p.net)} | ${p.sessions} sessions | ${winPct}% win\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("stats", async (ctx) => {
  try {
    const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!name) return ctx.reply("Usage: /stats <player name>");
    const { results, sessions, players } = await getData();
    const pr = results.filter((r) => r.player.toLowerCase() === name.toLowerCase());
    if (pr.length === 0) return ctx.reply(`No results found for "${name}".`);
    const actual = pr[0].player;
    const net = pr.reduce((a, r) => a + pl(r), 0);
    const wins = pr.filter((r) => pl(r) > 0).length;
    const avg = Math.round(net / pr.length);
    const totalBuyIns = pr.reduce((a, r) => a + totalIn(r), 0);
    const totalRebuys = pr.reduce((a, r) => a + r.rebuys, 0);
    const bestResult = pr.reduce((a, b) => (pl(a) > pl(b) ? a : b));
    const worstResult = pr.reduce((a, b) => (pl(a) < pl(b) ? a : b));

    let text = `\u{1F4CA} <b>${dn(actual, players)}</b>\n\n`;
    text += `\u{1F4B0} Net P/L: <b>${fmt(net)}</b>\n`;
    text += `\u{1F3AE} Sessions: ${pr.length}\n`;
    text += `\u{1F3AF} Win Rate: ${Math.round((wins / pr.length) * 100)}%\n`;
    text += `\u{1F4C8} Avg P/L: ${fmt(avg)}\n`;
    text += `\u{1F4B5} Total Invested: $${totalBuyIns.toLocaleString()}\n`;
    text += `\u{1F504} Total Rebuys: ${totalRebuys}\n`;
    text += `\u{1F4AA} Best Session: ${fmt(pl(bestResult))}\n`;
    text += `\u{1F915} Worst Session: ${fmt(pl(worstResult))}\n`;
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("sessions", async (ctx) => {
  try {
    const { sessions } = await getData();
    if (sessions.length === 0) return ctx.reply("No sessions yet.");
    let text = "\u{1F4C5} <b>SESSIONS</b>\n\n";
    [...sessions].reverse().forEach((s, idx, arr) => {
      text += `<b>S${arr.length - idx}</b> | ${s.date} | ${s.host} | ${s.gameType} ${s.stakes}\n   \u{1F4CD} ${s.location}\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("results", async (ctx) => {
  try {
    const num = parseInt(ctx.message.text.split(" ")[1]);
    const { sessions, results, players } = await getData();
    if (!num || num < 1 || num > sessions.length) return ctx.reply(`Usage: /results <1-${sessions.length}>`);
    const sess = sessions[num - 1];
    const sr = results.filter((r) => r.sessionId === sess.id);
    if (sr.length === 0) return ctx.reply(`No results for S${num}.`);
    let text = `\u{1F3B2} <b>S${num} — ${sess.date}</b>\n${sess.host} | ${sess.gameType} ${sess.stakes} | ${sess.location}\n\n`;
    sr.sort((a, b) => pl(b) - pl(a));
    const best = sr[0];
    sr.forEach((r) => {
      const n = pl(r);
      const mvp = r.id === best.id && n > 0 ? " \u{1F3C6}" : "";
      text += `${dn(r.player, players)}${mvp}\n   In: $${totalIn(r)} | Out: $${r.cashOut} | <b>${fmt(n)}</b>\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("settlements", async (ctx) => {
  try {
    const { results, players } = await getData();
    if (results.length === 0) return ctx.reply("No results yet.");
    const { txns } = settle(results);
    if (txns.length === 0) return ctx.reply("No settlements needed.");
    let text = "\u{1F4B8} <b>ALL-TIME SETTLEMENTS</b>\n\n";
    txns.forEach((t) => {
      text += `\u{1F534} ${dn(t.from, players)} \u{27A1}\u{FE0F} <b>$${t.amount}</b> \u{27A1}\u{FE0F} \u{1F7E2} ${dn(t.to, players)}\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("nextgame", async (ctx) => {
  try {
    const { nextGame, players } = await getData();
    if (!nextGame) return ctx.reply("No upcoming game scheduled.");
    const target = new Date(`${nextGame.date}T${nextGame.time || "19:00"}`);
    const diff = target - new Date();
    let countdown = "Starting now!";
    if (diff > 0) {
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      countdown = `${d > 0 ? d + "d " : ""}${h}h ${m}m`;
    }
    let text = `\u{1F3B0} <b>NEXT GAME</b>\n\n`;
    text += `\u{23F3} <b>${countdown}</b>\n\n`;
    text += `\u{1F4C5} ${nextGame.date} at ${nextGame.time || "TBD"}\n`;
    text += `\u{1F3E0} Host: ${nextGame.host}\n`;
    text += `\u{1F4CD} ${nextGame.location}\n`;
    text += `\u{1F4B0} ${nextGame.stakes} | ${nextGame.gameType}\n\n`;
    const confirmed = nextGame.confirmed || [];
    const declined = nextGame.declined || [];
    text += `\u{2705} Confirmed (${confirmed.length}): ${confirmed.length ? confirmed.map((p) => dn(p, players)).join(", ") : "none"}\n`;
    text += `\u{274C} Declined (${declined.length}): ${declined.length ? declined.map((p) => dn(p, players)).join(", ") : "none"}\n`;
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("summary", async (ctx) => {
  try {
    const { sessions, results, players, nextGame } = await getData();
    if (results.length === 0) return ctx.reply("No data yet. Add some sessions and results!");
    const totalPot = results.reduce((a, r) => a + totalIn(r), 0);
    const map = {};
    results.forEach((r) => {
      if (!map[r.player]) map[r.player] = { net: 0, sessions: 0 };
      map[r.player].net += pl(r);
      map[r.player].sessions += 1;
    });
    const sorted = Object.entries(map).sort((a, b) => b[1].net - a[1].net);
    const bigWin = results.reduce((a, b) => (pl(a) > pl(b) ? a : b));
    const bigLoss = results.reduce((a, b) => (pl(a) < pl(b) ? a : b));

    let text = `\u{1F3B0} <b>GTE POKER SUMMARY</b>\n\n`;
    text += `\u{1F4CA} ${sessions.length} sessions | ${results.length} results | ${players.length} players\n`;
    text += `\u{1F4B0} Total pot: $${totalPot.toLocaleString()}\n\n`;
    text += `\u{1F451} Top earner: ${dn(sorted[0][0], players)} (${fmt(sorted[0][1].net)})\n`;
    text += `\u{1F4A9} Biggest loser: ${dn(sorted[sorted.length - 1][0], players)} (${fmt(sorted[sorted.length - 1][1].net)})\n`;
    text += `\u{1F4AA} Best single session: ${dn(bigWin.player, players)} ${fmt(pl(bigWin))}\n`;
    text += `\u{1F915} Worst single session: ${dn(bigLoss.player, players)} ${fmt(pl(bigLoss))}\n`;
    if (nextGame) {
      text += `\n\u{1F3AE} Next game: ${nextGame.date} at ${nextGame.time || "TBD"} — ${(nextGame.confirmed || []).length} confirmed`;
    }
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

/* ════════════════════════════════════════════
   WRITE COMMANDS
   ════════════════════════════════════════════ */

/* ── Conversation state for multi-step commands ── */
const conversations = {};

bot.command("newsession", async (ctx) => {
  const userId = ctx.from.id;
  conversations[userId] = { type: "newsession", step: 0, data: {} };
  ctx.reply(
    "\u{1F4C5} <b>New Session</b>\n\nSend the date (YYYY-MM-DD):",
    { parse_mode: "HTML" }
  );
});

bot.command("addresult", async (ctx) => {
  try {
    const { sessions, players } = await getData();
    if (sessions.length === 0) return ctx.reply("No sessions yet. Create one first with /newsession");
    const userId = ctx.from.id;
    conversations[userId] = { type: "addresult", step: 0, data: {} };
    let sessionList = "Which session? Send the number:\n\n";
    sessions.forEach((s, i) => { sessionList += `<b>${i + 1}</b> — ${s.date} (${s.gameType} ${s.stakes})\n`; });
    ctx.reply(`\u{1F4DD} <b>Add Result</b>\n\n${sessionList}`, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("delsession", async (ctx) => {
  try {
    const num = parseInt(ctx.message.text.split(" ")[1]);
    const data = await getData();
    if (!num || num < 1 || num > data.sessions.length) return ctx.reply(`Usage: /delsession <1-${data.sessions.length}>`);
    const sess = data.sessions[num - 1];
    data.sessions = data.sessions.filter((s) => s.id !== sess.id);
    data.results = data.results.filter((r) => r.sessionId !== sess.id);
    await saveData(data);
    const msg = `\u{1F5D1} Deleted session S${num} (${sess.date} — ${sess.gameType})`;
    ctx.reply(msg);
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("delresult", async (ctx) => {
  try {
    const num = parseInt(ctx.message.text.split(" ")[1]);
    const data = await getData();
    if (!num || num < 1 || num > data.results.length) return ctx.reply(`Usage: /delresult <1-${data.results.length}>`);
    const sorted = [...data.results].reverse();
    const target = sorted[num - 1];
    data.results = data.results.filter((r) => r.id !== target.id);
    await saveData(data);
    const msg = `\u{1F5D1} Deleted result: ${target.player} from session ${target.sessionId}`;
    ctx.reply(msg);
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("schedule", async (ctx) => {
  const userId = ctx.from.id;
  conversations[userId] = { type: "schedule", step: 0, data: {} };
  ctx.reply(
    "\u{1F3AE} <b>Schedule Next Game</b>\n\nSend the date (YYYY-MM-DD):",
    { parse_mode: "HTML" }
  );
});

bot.command("cancelgame", async (ctx) => {
  try {
    await redis.set("gte:nextgame", JSON.stringify(null));
    const msg = "\u{274C} Next game has been cancelled.";
    ctx.reply(msg);
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("rsvp", async (ctx) => {
  try {
    const { players, nextGame } = await getData();
    if (!nextGame) return ctx.reply("No game scheduled. Use /schedule to create one.");
    const userId = ctx.from.id;
    conversations[userId] = { type: "rsvp", step: 0, data: {} };
    let playerList = "Who are you? Send the number:\n\n";
    players.forEach((p, i) => { playerList += `<b>${i + 1}</b> — ${p.avatar || "\u{1F3AD}"} ${p.name}\n`; });
    ctx.reply(`\u{1F3B2} <b>RSVP</b>\n\n${playerList}`, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

/* ════════════════════════════════════════════
   CONVERSATION HANDLER (multi-step input)
   ════════════════════════════════════════════ */

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const conv = conversations[userId];
  if (!conv) return;
  const text = ctx.message.text.trim();

  try {
    /* ── New Session flow ── */
    if (conv.type === "newsession") {
      if (conv.step === 0) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply("Please send a valid date (YYYY-MM-DD):");
        conv.data.date = text; conv.step = 1;
        return ctx.reply("Host name:");
      }
      if (conv.step === 1) { conv.data.host = text; conv.step = 2; return ctx.reply("Game type?\n1. NLH Cash\n2. PLO Cash\n3. NLH Tournament\n4. PLO Tournament\n5. Mixed\n6. Other"); }
      if (conv.step === 2) {
        const types = ["NLH Cash", "PLO Cash", "NLH Tournament", "PLO Tournament", "Mixed", "Other"];
        const idx = parseInt(text) - 1;
        conv.data.gameType = (idx >= 0 && idx < types.length) ? types[idx] : text;
        conv.step = 3;
        return ctx.reply("Stakes (e.g. 1/2):");
      }
      if (conv.step === 3) { conv.data.stakes = text; conv.step = 4; return ctx.reply("Location:"); }
      if (conv.step === 4) {
        conv.data.location = text;
        const data = await getData();
        const id = data.counters.nextSId || data.sessions.length + 1;
        const sess = { id, date: conv.data.date, host: conv.data.host, gameType: conv.data.gameType, stakes: conv.data.stakes, location: conv.data.location };
        data.sessions.push(sess);
        data.counters.nextSId = id + 1;
        await saveData(data);
        delete conversations[userId];
        const msg = `\u{2705} Session S${data.sessions.length} created!\n\n\u{1F4C5} ${sess.date} | ${sess.host}\n\u{1F3AE} ${sess.gameType} ${sess.stakes}\n\u{1F4CD} ${sess.location}`;
        ctx.reply(msg);
        notify(msg);
        return;
      }
    }

    /* ── Add Result flow ── */
    if (conv.type === "addresult") {
      const data = await getData();
      if (conv.step === 0) {
        const num = parseInt(text);
        if (!num || num < 1 || num > data.sessions.length) return ctx.reply(`Send a number 1-${data.sessions.length}:`);
        conv.data.sessionId = data.sessions[num - 1].id;
        conv.data.sessionNum = num;
        conv.step = 1;
        let playerList = "Player? Send number or name:\n\n";
        data.players.forEach((p, i) => { playerList += `${i + 1}. ${p.avatar || "\u{1F3AD}"} ${p.name}\n`; });
        return ctx.reply(playerList);
      }
      if (conv.step === 1) {
        const num = parseInt(text);
        if (num >= 1 && num <= data.players.length) {
          conv.data.player = data.players[num - 1].name;
        } else {
          conv.data.player = text;
        }
        conv.step = 2;
        return ctx.reply(`Buy-in amount ($):`);
      }
      if (conv.step === 2) {
        const val = parseInt(text.replace(/[$,]/g, ""));
        if (isNaN(val) || val < 0) return ctx.reply("Send a valid dollar amount:");
        conv.data.buyIn = val; conv.step = 3;
        return ctx.reply("Number of rebuys (0 if none):");
      }
      if (conv.step === 3) {
        const val = parseInt(text);
        if (isNaN(val) || val < 0) return ctx.reply("Send a valid number:");
        conv.data.rebuys = val; conv.step = 4;
        return ctx.reply("Cash-out amount ($):");
      }
      if (conv.step === 4) {
        const val = parseInt(text.replace(/[$,]/g, ""));
        if (isNaN(val) || val < 0) return ctx.reply("Send a valid dollar amount:");
        conv.data.cashOut = val;
        const id = data.counters.nextRId || data.results.length + 1;
        const result = { id, sessionId: conv.data.sessionId, player: conv.data.player, buyIn: conv.data.buyIn, rebuys: conv.data.rebuys, cashOut: conv.data.cashOut };
        data.results.push(result);
        data.counters.nextRId = id + 1;
        await saveData(data);
        delete conversations[userId];
        const n = pl(result);
        const msg = `\u{2705} Result added to S${conv.data.sessionNum}\n\n${dn(result.player, data.players)}\nBuy-in: $${result.buyIn} | Rebuys: ${result.rebuys} | Cash-out: $${result.cashOut}\nP/L: <b>${fmt(n)}</b>`;
        ctx.reply(msg, { parse_mode: "HTML" });
        notify(msg);
        return;
      }
    }

    /* ── Schedule flow ── */
    if (conv.type === "schedule") {
      if (conv.step === 0) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply("Please send a valid date (YYYY-MM-DD):");
        conv.data.date = text; conv.step = 1;
        return ctx.reply("Time (HH:MM, 24h format):");
      }
      if (conv.step === 1) {
        conv.data.time = text; conv.step = 2;
        return ctx.reply("Host:");
      }
      if (conv.step === 2) { conv.data.host = text; conv.step = 3; return ctx.reply("Location:"); }
      if (conv.step === 3) { conv.data.location = text; conv.step = 4; return ctx.reply("Stakes (e.g. 1/2):"); }
      if (conv.step === 4) {
        conv.data.stakes = text; conv.step = 5;
        return ctx.reply("Game type?\n1. NLH Cash\n2. PLO Cash\n3. NLH Tournament\n4. PLO Tournament\n5. Mixed\n6. Other");
      }
      if (conv.step === 5) {
        const types = ["NLH Cash", "PLO Cash", "NLH Tournament", "PLO Tournament", "Mixed", "Other"];
        const idx = parseInt(text) - 1;
        conv.data.gameType = (idx >= 0 && idx < types.length) ? types[idx] : text;
        const ng = { date: conv.data.date, time: conv.data.time, host: conv.data.host, location: conv.data.location, stakes: conv.data.stakes, gameType: conv.data.gameType, confirmed: [], declined: [] };
        await redis.set("gte:nextgame", JSON.stringify(ng));
        delete conversations[userId];
        const msg = `\u{1F3AE} <b>GAME SCHEDULED!</b>\n\n\u{1F4C5} ${ng.date} at ${ng.time}\n\u{1F3E0} ${ng.host}\n\u{1F4CD} ${ng.location}\n\u{1F4B0} ${ng.stakes} | ${ng.gameType}\n\nUse /rsvp to confirm!`;
        ctx.reply(msg, { parse_mode: "HTML" });
        notify(msg);
        return;
      }
    }

    /* ── RSVP flow ── */
    if (conv.type === "rsvp") {
      const data = await getData();
      if (conv.step === 0) {
        const num = parseInt(text);
        if (!num || num < 1 || num > data.players.length) return ctx.reply(`Send a number 1-${data.players.length}:`);
        conv.data.player = data.players[num - 1].name;
        conv.step = 1;
        return ctx.reply(`${dn(conv.data.player, data.players)}\n\n1. \u{2705} I'm in\n2. \u{274C} Can't make it`);
      }
      if (conv.step === 1) {
        const choice = text.toLowerCase();
        const status = (choice === "1" || choice.includes("in") || choice.includes("yes") || choice.includes("confirm")) ? "confirmed" : "declined";
        const game = data.nextGame;
        if (!game) { delete conversations[userId]; return ctx.reply("No game scheduled."); }
        if (!game.confirmed) game.confirmed = [];
        if (!game.declined) game.declined = [];
        game.confirmed = game.confirmed.filter((p) => p !== conv.data.player);
        game.declined = game.declined.filter((p) => p !== conv.data.player);
        if (status === "confirmed") game.confirmed.push(conv.data.player);
        else game.declined.push(conv.data.player);
        await redis.set("gte:nextgame", JSON.stringify(game));
        delete conversations[userId];
        const emoji = status === "confirmed" ? "\u{2705}" : "\u{274C}";
        const msg = `${emoji} ${dn(conv.data.player, data.players)} ${status} for ${game.date}`;
        ctx.reply(msg);
        notify(msg);
        return;
      }
    }
  } catch (e) {
    delete conversations[userId];
    ctx.reply(`Error: ${e.message}`);
  }
});

/* ── Launch with retry (handles 409 conflict during redeploys) ── */
async function launchWithRetry(maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log(`Bot started: @${bot.botInfo?.username}`);
      return;
    } catch (err) {
      if (err?.response?.error_code === 409 && i < maxRetries - 1) {
        const wait = (i + 1) * 3;
        console.log(`409 conflict, retrying in ${wait}s... (${i + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        console.error("Bot launch failed:", err);
        process.exit(1);
      }
    }
  }
}
launchWithRetry();

process.once("SIGINT", () => { bot.stop("SIGINT"); redis.disconnect(); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); redis.disconnect(); });
