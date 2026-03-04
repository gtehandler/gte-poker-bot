require("dotenv").config();
const { Telegraf } = require("telegraf");
const Redis = require("ioredis");

/* ══════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════ */
const BOT_TOKEN = process.env.BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_USERS = (process.env.ADMIN_USERS || "").split(",").map(Number).filter(Boolean);
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || "";

if (!BOT_TOKEN) { console.error("BOT_TOKEN required"); process.exit(1); }
if (!REDIS_URL) { console.error("REDIS_URL required"); process.exit(1); }

/* ══════════════════════════════════════════════
   REDIS
   ══════════════════════════════════════════════ */
const redisOpts = {};
if (REDIS_URL.startsWith("rediss://")) redisOpts.tls = { rejectUnauthorized: false };
const redis = new Redis(REDIS_URL, redisOpts);
redis.on("error", (err) => console.error("Redis error:", err));
redis.on("connect", () => console.log("Redis connected"));

/* ══════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════ */
function totalIn(r) { return r.buyIn * (1 + r.rebuys); }
function pl(r) { return r.cashOut - totalIn(r); }
function fmt(n) { return n >= 0 ? `+$${n.toLocaleString()}` : `-$${Math.abs(n).toLocaleString()}`; }

async function getData() {
  const [sessions, results, players, counters, nextGame] = await Promise.all([
    redis.get("gte:sessions"), redis.get("gte:results"), redis.get("gte:players"),
    redis.get("gte:counters"), redis.get("gte:nextgame"),
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

async function getTgMap() {
  const raw = await redis.get("gte:tgmap");
  return raw ? JSON.parse(raw) : {};
}

async function saveTgMap(map) {
  await redis.set("gte:tgmap", JSON.stringify(map));
}

function dn(player, players) {
  const p = players.find((x) => x.name === player);
  const av = p?.avatar || "\u{1F3AD}";
  const nick = p?.nickname;
  return nick ? `${av} ${player} "${nick}"` : `${av} ${player}`;
}

function findPlayer(input, players) {
  if (!input) return null;
  const lower = input.toLowerCase().trim();
  const exact = players.find((p) => p.name.toLowerCase() === lower);
  if (exact) return exact.name;
  const partial = players.filter((p) => p.name.toLowerCase().startsWith(lower));
  if (partial.length === 1) return partial[0].name;
  return null;
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
    debtors[i].amount -= amt; creditors[j].amount -= amt;
    if (debtors[i].amount < 0.01) i++;
    if (creditors[j].amount < 0.01) j++;
  }
  return { txns, net };
}

function isAdmin(ctx) { return ADMIN_USERS.includes(ctx.from?.id); }

/* ══════════════════════════════════════════════
   STATS FUNCTIONS (ported from Poker.jsx)
   ══════════════════════════════════════════════ */

function getStreak(playerName, results, sessions) {
  const pr = results
    .filter((r) => r.player === playerName)
    .map((r) => ({ ...r, date: sessions.find((s) => s.id === r.sessionId)?.date || "" }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pr.length < 2) return { type: null, count: 0 };
  const last = pr[pr.length - 1];
  const lastPl = pl(last);
  if (lastPl === 0) return { type: null, count: 0 };
  const dir = lastPl > 0 ? "hot" : "cold";
  let count = 1;
  for (let i = pr.length - 2; i >= 0; i--) {
    const n = pl(pr[i]);
    if ((dir === "hot" && n > 0) || (dir === "cold" && n < 0)) count++;
    else break;
  }
  return count >= 2 ? { type: dir, count } : { type: null, count: 0 };
}

function calcPowerRankings(results, sessions) {
  const playerMap = {};
  results.forEach((r) => {
    if (!playerMap[r.player]) playerMap[r.player] = { results: [], plValues: [] };
    playerMap[r.player].results.push(r);
    playerMap[r.player].plValues.push(pl(r));
  });
  const totalSessions = sessions.length;
  return Object.entries(playerMap)
    .filter(([, data]) => data.results.length >= 2)
    .map(([player, data]) => {
      const wins = data.plValues.filter((v) => v > 0).length;
      const winRate = wins / data.results.length;
      const invested = data.results.reduce((a, r) => a + totalIn(r), 0);
      const netProfit = data.plValues.reduce((a, b) => a + b, 0);
      const roi = invested > 0 ? netProfit / invested : 0;
      const mean = netProfit / data.results.length;
      const variance = data.plValues.reduce((a, v) => a + (v - mean) ** 2, 0) / data.results.length;
      const stdDev = Math.sqrt(variance);
      const maxPl = Math.max(...data.plValues.map(Math.abs), 1);
      const consistency = 1 - Math.min(stdDev / maxPl, 1);
      const attendance = data.results.length / Math.max(totalSessions, 1);
      const roiNorm = (Math.max(Math.min(roi, 1), -1) + 1) / 2;
      const raw = winRate * 0.30 + roiNorm * 0.25 + consistency * 0.25 + attendance * 0.20;
      const score = Math.round(raw * 100);
      return { player, score, winRate, roi, consistency, attendance, sessions: data.results.length };
    })
    .sort((a, b) => b.score - a.score);
}

function calcBadges(results, sessions) {
  const badges = {};
  const playerMap = {};
  results.forEach((r) => {
    if (!playerMap[r.player]) playerMap[r.player] = { results: [], sessionIds: new Set() };
    playerMap[r.player].results.push(r);
    playerMap[r.player].sessionIds.add(r.sessionId);
  });
  Object.entries(playerMap).forEach(([name, data]) => {
    const b = [];
    const plValues = data.results.map((r) => pl(r));
    if (data.sessionIds.size >= 5) b.push({ id: "ironman", label: "Iron Man", emoji: "\u{1F9BE}", desc: "Attended 5+ sessions" });
    const hasComebacks = data.results.some((r) => r.rebuys >= 2 && pl(r) > 0);
    if (hasComebacks) b.push({ id: "comeback", label: "Comeback Kid", emoji: "\u{1F504}", desc: "Profited after 2+ rebuys" });
    const noRebuyResults = data.results.filter((r) => r.rebuys === 0);
    if (noRebuyResults.length >= 2) {
      const noRebuyNet = noRebuyResults.reduce((a, r) => a + pl(r), 0);
      const noRebuyIn = noRebuyResults.reduce((a, r) => a + r.buyIn, 0);
      if (noRebuyIn > 0 && noRebuyNet / noRebuyIn > 0.5) b.push({ id: "sniper", label: "Sniper", emoji: "\u{1F3AF}", desc: "50%+ ROI with zero rebuys" });
    }
    const sorted = [...data.results].sort((a, b) => {
      const sa = sessions.find((s) => s.id === a.sessionId);
      const sb = sessions.find((s) => s.id === b.sessionId);
      return (sa?.date || "").localeCompare(sb?.date || "");
    });
    if (sorted.length > 0 && pl(sorted[0]) > 0) b.push({ id: "firstblood", label: "First Blood", emoji: "\u{1FA78}", desc: "Won their first session" });
    const maxProfit = Math.max(...plValues);
    if (maxProfit >= 500) b.push({ id: "highroller", label: "High Roller", emoji: "\u{1F48E}", desc: `$${maxProfit} single session profit` });
    const maxRebuys = Math.max(...data.results.map((r) => r.rebuys));
    if (maxRebuys >= 3) b.push({ id: "atm", label: "ATM", emoji: "\u{1F3E7}", desc: `${maxRebuys} rebuys in one session` });
    badges[name] = b;
  });
  let maxSessions = 0, grinder = null, maxInPlay = 0, whale = null;
  Object.entries(playerMap).forEach(([name, data]) => {
    if (data.sessionIds.size > maxSessions) { maxSessions = data.sessionIds.size; grinder = name; }
    const tip = data.results.reduce((a, r) => a + totalIn(r), 0);
    if (tip > maxInPlay) { maxInPlay = tip; whale = name; }
  });
  if (grinder && maxSessions >= 2) { if (!badges[grinder]) badges[grinder] = []; badges[grinder].push({ id: "grinder", label: "The Grinder", emoji: "\u{2699}\u{FE0F}", desc: "Most sessions played" }); }
  if (whale) { if (!badges[whale]) badges[whale] = []; badges[whale].push({ id: "whale", label: "Whale", emoji: "\u{1F40B}", desc: "Most money put in play" }); }
  return badges;
}

function generateTrashTalk(results, sessions, players) {
  const msgs = [];
  const playerMap = {};
  results.forEach((r) => {
    if (!playerMap[r.player]) playerMap[r.player] = { results: [], net: 0, rebuys: 0 };
    playerMap[r.player].results.push(r);
    playerMap[r.player].net += pl(r);
    playerMap[r.player].rebuys += r.rebuys;
  });
  Object.entries(playerMap).forEach(([name, data]) => {
    const streak = getStreak(name, results, sessions);
    const d = dn(name, players);
    if (streak.type === "cold" && streak.count >= 2) msgs.push(`${d} has lost ${streak.count} sessions in a row \u{1F480}`);
    if (streak.type === "hot" && streak.count >= 2) msgs.push(`${d} just won't stop winning \u{1F525}`);
    if (data.net > 0 && data.results.length >= 2) msgs.push(`${d} is up $${data.net.toLocaleString()} all-time... must be nice \u{1F3C1}`);
    if (data.rebuys >= 3) msgs.push(`${d} has ${data.rebuys} lifetime rebuys... someone call the bank \u{1F3E7}`);
    const winRate = data.results.length ? Math.round((data.results.filter((r) => pl(r) > 0).length / data.results.length) * 100) : 0;
    if (winRate <= 25 && data.results.length >= 2) msgs.push(`${d}'s win rate is only ${winRate}%... thoughts and prayers \u{1F64F}`);
    if (winRate >= 75 && data.results.length >= 2) msgs.push(`${d} wins ${winRate}% of the time... are they cheating? \u{1F914}`);
    if (data.net < -500) msgs.push(`${d} is stuck $${Math.abs(data.net).toLocaleString()}... it's just a bad run, right? \u{1F62C}`);
  });
  if (results.length > 0) {
    const biggestWin = results.reduce((a, b) => (pl(a) > pl(b) ? a : b));
    if (pl(biggestWin) > 0) msgs.push(`Biggest single win ever: ${dn(biggestWin.player, players)} took $${pl(biggestWin).toLocaleString()} in one session \u{1F4B0}`);
  }
  return msgs.length > 0 ? msgs : ["No trash talk yet... play more sessions! \u{1F0CF}"];
}

function calcH2H(player1, player2, results, sessions) {
  const shared = sessions.filter((s) => {
    const sr = results.filter((r) => r.sessionId === s.id);
    return sr.some((r) => r.player === player1) && sr.some((r) => r.player === player2);
  });
  const p1r = results.filter((r) => r.player === player1 && shared.some((s) => s.id === r.sessionId));
  const p2r = results.filter((r) => r.player === player2 && shared.some((s) => s.id === r.sessionId));
  const breakdown = shared.map((s) => {
    const r1 = results.find((r) => r.player === player1 && r.sessionId === s.id);
    const r2 = results.find((r) => r.player === player2 && r.sessionId === s.id);
    return { num: sessions.indexOf(s) + 1, date: s.date, p1pl: r1 ? pl(r1) : 0, p2pl: r2 ? pl(r2) : 0 };
  });
  return {
    shared: shared.length,
    p1: { net: p1r.reduce((a, r) => a + pl(r), 0), wins: p1r.filter((r) => pl(r) > 0).length },
    p2: { net: p2r.reduce((a, r) => a + pl(r), 0), wins: p2r.filter((r) => pl(r) > 0).length },
    breakdown,
  };
}

function calcLocationStats(sessions, results) {
  const locs = {};
  sessions.forEach((s) => {
    const key = s.location || "Unknown";
    if (!locs[key]) locs[key] = { sessions: [], results: [] };
    locs[key].sessions.push(s);
  });
  results.forEach((r) => {
    const sess = sessions.find((s) => s.id === r.sessionId);
    const key = sess?.location || "Unknown";
    if (locs[key]) locs[key].results.push(r);
  });
  return Object.entries(locs).map(([loc, data]) => {
    const totalPot = data.results.reduce((a, r) => a + totalIn(r), 0);
    const avgPot = data.sessions.length ? Math.round(totalPot / data.sessions.length) : 0;
    const playerNets = {};
    data.results.forEach((r) => { playerNets[r.player] = (playerNets[r.player] || 0) + pl(r); });
    const sorted = Object.entries(playerNets).sort((a, b) => b[1] - a[1]);
    return {
      location: loc, sessionCount: data.sessions.length, totalPot, avgPot,
      bestPlayer: sorted[0] || null, worstPlayer: sorted[sorted.length - 1] || null,
    };
  });
}

function calcHallOfFame(results) {
  if (results.length === 0) return null;
  const best = results.reduce((a, b) => (pl(a) > pl(b) ? a : b));
  const worst = results.reduce((a, b) => (pl(a) < pl(b) ? a : b));
  return { best: { player: best.player, amount: pl(best), sessionId: best.sessionId }, worst: { player: worst.player, amount: pl(worst), sessionId: worst.sessionId } };
}

/* ══════════════════════════════════════════════
   KANYE QUOTES
   ══════════════════════════════════════════════ */
const KANYE_QUOTES = [
  // Interview & tweet quotes
  "I am a god. I am a god. I am a god.",
  "I'm living in the future so the present is my past.",
  "I refuse to accept other people's ideas of happiness for me.",
  "People always tell you 'Be humble. Be humble.' When was the last time someone told you to be amazing?",
  "I'm not comfortable with comfort. I'm only comfortable when I'm in a place where I'm constantly learning.",
  "Having money isn't everything. Not having it is.",
  "If you have the opportunity to play this game of life you need to appreciate every moment.",
  "I feel like I'm too busy writing history to read it.",
  "Believe in your flyness... conquer your shyness.",
  "I'm on the pursuit of awesomeness, excellence is the bare minimum.",
  "I am Warhol. I am the number one most impactful artist of our generation.",
  "My greatest pain in life is that I will never be able to see myself perform live.",
  "I'm a creative genius and there's no other way to word it.",
  "They say people in your life are seasons and anything that happen is for a reason.",
  "I still think I am the greatest.",
  "Nothing in life is promised except death.",
  "Would you believe in what you believe in if you were the only one who believed it?",
  "For me giving up is way harder than trying.",
  "Distraction is the enemy of vision.",
  "Everything I'm not made me everything I am.",
  "You can't look at a glass half full or empty if it's overflowing.",
  "I hate when I'm on a flight and I wake up with a water bottle next to me like oh great now I gotta be responsible for this water bottle.",
  "Sometimes I push the door close button on people running towards the elevator. I just need my own elevator sometimes.",
  "I'm nice at ping pong.",
  "I feel like me and Taylor might still have sex. Why? I made that girl famous.",
  // Song lyrics
  "N-n-now th-that that don't kill me, can only make me stronger.",
  "No one man should have all that power.",
  "We don't care what people say.",
  "Through the wire, through the wire, through the wire.",
  "Jesus walks with me.",
  "Touch the sky, I gotta testify, come up in the spot looking extra fly.",
  "Good morning, look at the valedictorian, scared of the future while I hop in the DeLorean.",
  "Mayonnaise colored Benz, I push Miracle Whips.",
  "I got a problem with spending before I get it. We all self-conscious, I'm just the first to admit it.",
  "We're all self-conscious. I'm just the first to admit it.",
  "The plan was to drink until the pain over, but what's worse, the pain or the hangover?",
  "I could let these dream killers kill my self-esteem, or use my arrogance as the steam to power my dreams.",
  "Reach for the stars so if you fall you land on a cloud.",
  "I know I got angels watchin' me from the other side.",
  "One good girl is worth a thousand ones.",
  "Closed on Sunday, you my Chick-fil-A.",
  "Hurry up with my damn croissants.",
  "I just needed time alone with my own thoughts. Got treasures in my mind but couldn't open up my own vault.",
  "Run away fast as you can.",
  "Father, stretch my hands.",
  "Ultralight beam. This is a God dream.",
  "I miss the old Kanye, straight from the go Kanye.",
  "I'm so gifted at finding what I don't like the most.",
  "Put your hands to the constellations, the way you look should be a sin, you my sensation.",
  "Screams from the haters, got a nice ring to it. I guess every superhero need his theme music.",
];

/* ══════════════════════════════════════════════
   BOT SETUP
   ══════════════════════════════════════════════ */
const bot = new Telegraf(BOT_TOKEN);
const conversations = {};

/* ── Notify helper ── */
async function notify(text) {
  if (GROUP_CHAT_ID) {
    try { await bot.telegram.sendMessage(GROUP_CHAT_ID, text, { parse_mode: "HTML" }); }
    catch (e) { console.error("Group notify failed:", e.message); }
  }
}

/* ══════════════════════════════════════════════
   AUTH MIDDLEWARE
   ══════════════════════════════════════════════ */
bot.use(async (ctx, next) => {
  const text = ctx.message?.text || "";
  const cmd = text.split(" ")[0].toLowerCase().replace(/^\//, "").split("@")[0];
  console.log(`[MW] update type=${ctx.updateType} cmd="${cmd}" from=${ctx.from?.id} text="${text.slice(0, 50)}"`);

  // /start and /register are open to everyone
  if (cmd === "start" || cmd === "register") return next();

  // All other commands require registration
  const tgMap = await getTgMap();
  const playerName = tgMap[String(ctx.from?.id)];
  if (!playerName) {
    return ctx.reply("\u{1F6AB} You need to register first.\nUse /register to link your Telegram account to your player name.");
  }
  ctx.state.playerName = playerName;
  return next();
});

/* ══════════════════════════════════════════════
   /start — HELP MENU
   ══════════════════════════════════════════════ */
bot.command("start", async (ctx) => {
  const tgMap = await getTgMap();
  const playerName = tgMap[String(ctx.from?.id)];
  const regStatus = playerName ? `\u{2705} Registered as <b>${playerName}</b>` : "\u{26A0}\u{FE0F} Not registered — use /register";

  ctx.reply(
    `\u{1F3B0} <b>GTE Poker Bot</b>\n${regStatus}\n\n` +
    `<b>\u{1F4D6} Read Commands</b>\n` +
    `/lb — Leaderboard\n` +
    `/stats [player] — Player stats\n` +
    `/pnl — Your P/L summary\n` +
    `/sessions — List sessions\n` +
    `/results &lt;#&gt; — Session results\n` +
    `/livesession — Current session\n` +
    `/settlements — Who owes whom\n` +
    `/nextgame — Next game info\n` +
    `/summary — Quick overview\n` +
    `/rankings — Power rankings\n` +
    `/badges [player] — Achievements\n` +
    `/streaks — Hot/cold streaks\n` +
    `/h2h &lt;p1&gt; &lt;p2&gt; — Head-to-head\n` +
    `/locations — Venue stats\n` +
    `/hof — Hall of fame/shame\n` +
    `/trashtalk — Roast messages\n` +
    `/ifeellikepablo — Ye wisdom\n\n` +
    `<b>\u{270D}\u{FE0F} Write Commands</b>\n` +
    `/buyin &lt;amount&gt; — Buy in\n` +
    `/cashout &lt;amount&gt; — Cash out\n` +
    `/rsvp — Confirm for next game\n` +
    `/cancelrsvp — Cancel RSVP\n` +
    `/schedule — Schedule a game\n` +
    `/cancelschedule — Cancel game\n\n` +
    (isAdmin(ctx) ?
      `<b>\u{1F6E1} Admin Commands</b>\n` +
      `/newsession — Create session\n` +
      `/addresult — Add a result\n` +
      `/delsession &lt;#&gt; — Delete session\n` +
      `/delresult &lt;#&gt; — Delete result\n\n` : "") +
    `\u{1F310} <a href="https://gte-poker.vercel.app">Open Web App</a>`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

/* ══════════════════════════════════════════════
   /register — LINK TG ACCOUNT TO PLAYER NAME
   ══════════════════════════════════════════════ */
bot.command("register", async (ctx) => {
  try {
    const { players } = await getData();
    const tgMap = await getTgMap();
    const userId = String(ctx.from.id);
    const current = tgMap[userId];

    if (players.length === 0) return ctx.reply("No players in the system yet. Ask an admin to add players via the web app.");

    conversations[ctx.from.id] = { type: "register", step: 0, data: {} };
    let text = "\u{1F4CB} <b>Register</b>\n\n";
    if (current) text += `Currently registered as: <b>${current}</b>\n\n`;
    text += "Pick your name:\n\n";
    players.forEach((p, i) => {
      const claimed = Object.entries(tgMap).find(([uid, name]) => name === p.name && uid !== userId);
      const tag = claimed ? " (taken)" : "";
      text += `<b>${i + 1}</b> — ${p.avatar || "\u{1F3AD}"} ${p.name}${tag}\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

/* ══════════════════════════════════════════════
   READ COMMANDS
   ══════════════════════════════════════════════ */

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
      text += `${badge} ${dn(p.player, players)}\n   ${color} ${fmt(p.net)} | ${p.sessions} sess | ${winPct}% win\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("stats", async (ctx) => {
  try {
    const nameArg = ctx.message.text.split(" ").slice(1).join(" ").trim();
    const { results, sessions, players } = await getData();
    const target = nameArg ? findPlayer(nameArg, players) : ctx.state.playerName;
    if (!target) return ctx.reply(`Player "${nameArg}" not found.`);
    const pr = results.filter((r) => r.player === target);
    if (pr.length === 0) return ctx.reply(`No results found for ${target}.`);
    const net = pr.reduce((a, r) => a + pl(r), 0);
    const wins = pr.filter((r) => pl(r) > 0).length;
    const avg = Math.round(net / pr.length);
    const totalBuyIns = pr.reduce((a, r) => a + totalIn(r), 0);
    const totalRebuys = pr.reduce((a, r) => a + r.rebuys, 0);
    const bestResult = pr.reduce((a, b) => (pl(a) > pl(b) ? a : b));
    const worstResult = pr.reduce((a, b) => (pl(a) < pl(b) ? a : b));
    const streak = getStreak(target, results, sessions);
    const streakText = streak.type === "hot" ? ` \u{1F525} ${streak.count}W streak` : streak.type === "cold" ? ` \u{1F9CA} ${streak.count}L streak` : "";

    let text = `\u{1F4CA} <b>${dn(target, players)}</b>${streakText}\n\n`;
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

bot.command("pnl", async (ctx) => {
  try {
    const { results, sessions, players } = await getData();
    const target = ctx.state.playerName;
    const pr = results.filter((r) => r.player === target);
    if (pr.length === 0) return ctx.reply("You have no results yet.");
    const net = pr.reduce((a, r) => a + pl(r), 0);
    const wins = pr.filter((r) => pl(r) > 0).length;
    const avg = Math.round(net / pr.length);
    const streak = getStreak(target, results, sessions);
    const streakText = streak.type === "hot" ? `\u{1F525} ${streak.count}W streak` : streak.type === "cold" ? `\u{1F9CA} ${streak.count}L streak` : "No streak";
    const invested = pr.reduce((a, r) => a + totalIn(r), 0);
    const roi = invested > 0 ? Math.round((net / invested) * 100) : 0;

    // Recent 5 sessions
    const recent = [...pr]
      .map((r) => ({ ...r, date: sessions.find((s) => s.id === r.sessionId)?.date || "" }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);

    let text = `\u{1F4B0} <b>${dn(target, players)} — P/L</b>\n\n`;
    text += `Net: <b>${fmt(net)}</b> | ROI: ${roi}%\n`;
    text += `${pr.length} sessions | ${Math.round((wins / pr.length) * 100)}% win | ${streakText}\n`;
    text += `Avg: ${fmt(avg)} per session\n\n`;
    text += `<b>Recent:</b>\n`;
    recent.forEach((r) => {
      const n = pl(r);
      const emoji = n >= 0 ? "\u{1F7E2}" : "\u{1F534}";
      text += `${emoji} ${r.date} — ${fmt(n)}\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("livesession", async (ctx) => {
  try {
    const { sessions, results, players } = await getData();
    if (sessions.length === 0) return ctx.reply("No sessions yet.");
    const latest = sessions[sessions.length - 1];
    const num = sessions.length;
    const sr = results.filter((r) => r.sessionId === latest.id);

    let text = `\u{1F3B0} <b>LIVE SESSION — S${num}</b>\n`;
    text += `${latest.date} | ${latest.host} | ${latest.gameType} ${latest.stakes}\n\u{1F4CD} ${latest.location}\n\n`;

    if (sr.length === 0) {
      text += "No players yet. Use /buyin to join!\n";
    } else {
      let totalPot = 0;
      let stillPlaying = 0;
      sr.sort((a, b) => pl(b) - pl(a));
      sr.forEach((r) => {
        totalPot += totalIn(r);
        const rebuyText = r.rebuys > 0 ? ` (${r.rebuys} rebuy${r.rebuys > 1 ? "s" : ""})` : "";
        if (r.cashOut > 0) {
          const n = pl(r);
          text += `${dn(r.player, players)}\n   In: $${totalIn(r)}${rebuyText} | Out: $${r.cashOut} | <b>${fmt(n)}</b>\n\n`;
        } else {
          stillPlaying++;
          text += `${dn(r.player, players)}\n   In: $${totalIn(r)}${rebuyText} | Out: <i>pending</i>\n\n`;
        }
      });
      text += `\u{1F4B0} Total pot: $${totalPot.toLocaleString()}`;
      if (stillPlaying > 0) text += ` | ${stillPlaying} still playing`;
    }
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
    if (!nextGame) return ctx.reply("No upcoming game scheduled. Use /schedule to create one.");
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
      text += `\n\u{1F3AE} Next game: ${nextGame.date} at ${nextGame.time || "TBD"} \u{2014} ${(nextGame.confirmed || []).length} confirmed`;
    }
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("rankings", async (ctx) => {
  try {
    const { results, sessions, players } = await getData();
    const rankings = calcPowerRankings(results, sessions);
    if (rankings.length === 0) return ctx.reply("Not enough data for power rankings (players need 2+ sessions).");
    let text = "\u{1F4AA} <b>POWER RANKINGS</b>\n\n";
    rankings.forEach((r, i) => {
      const color = r.score >= 70 ? "\u{1F7E2}" : r.score >= 50 ? "\u{1F7E1}" : r.score >= 30 ? "\u{1F7E0}" : "\u{1F534}";
      text += `#${i + 1} ${dn(r.player, players)} ${color} <b>${r.score}/100</b>\n`;
      text += `   Win: ${Math.round(r.winRate * 100)}% | ROI: ${Math.round(r.roi * 100)}% | Consistency: ${Math.round(r.consistency * 100)}% | Attendance: ${Math.round(r.attendance * 100)}%\n\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("badges", async (ctx) => {
  try {
    const nameArg = ctx.message.text.split(" ").slice(1).join(" ").trim();
    const { results, sessions, players } = await getData();
    const badges = calcBadges(results, sessions);

    if (nameArg) {
      const target = findPlayer(nameArg, players);
      if (!target) return ctx.reply(`Player "${nameArg}" not found.`);
      const pb = badges[target] || [];
      if (pb.length === 0) return ctx.reply(`${dn(target, players)} has no badges yet.`);
      let text = `\u{1F3C5} <b>${dn(target, players)} — Badges</b>\n\n`;
      pb.forEach((b) => { text += `${b.emoji} <b>${b.label}</b> — ${b.desc}\n`; });
      return ctx.reply(text, { parse_mode: "HTML" });
    }

    // Default: show own badges
    const target = ctx.state.playerName;
    const pb = badges[target] || [];
    if (pb.length === 0) return ctx.reply("You have no badges yet. Keep playing!");
    let text = `\u{1F3C5} <b>${dn(target, players)} — Badges</b>\n\n`;
    pb.forEach((b) => { text += `${b.emoji} <b>${b.label}</b> — ${b.desc}\n`; });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("streaks", async (ctx) => {
  try {
    const { results, sessions, players } = await getData();
    const playerNames = [...new Set(results.map((r) => r.player))];
    const streaks = playerNames
      .map((name) => ({ name, ...getStreak(name, results, sessions) }))
      .filter((s) => s.type !== null)
      .sort((a, b) => b.count - a.count);

    if (streaks.length === 0) return ctx.reply("No active streaks right now.");
    let text = "\u{1F525}\u{1F9CA} <b>STREAKS</b>\n\n";
    streaks.forEach((s) => {
      const emoji = s.type === "hot" ? "\u{1F525}" : "\u{1F9CA}";
      const label = s.type === "hot" ? `${s.count}W streak` : `${s.count}L streak`;
      text += `${emoji} ${dn(s.name, players)} — ${label}\n`;
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("h2h", async (ctx) => {
  try {
    const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!args) return ctx.reply("Usage: /h2h <player1> vs <player2>\nExample: /h2h Alice vs Bob");
    const parts = args.split(/\s+vs\s+|\s+v\s+|\s*,\s*/i);
    if (parts.length < 2) return ctx.reply("Usage: /h2h <player1> vs <player2>");
    const { results, sessions, players } = await getData();
    const p1 = findPlayer(parts[0].trim(), players);
    const p2 = findPlayer(parts[1].trim(), players);
    if (!p1) return ctx.reply(`Player "${parts[0].trim()}" not found.`);
    if (!p2) return ctx.reply(`Player "${parts[1].trim()}" not found.`);
    if (p1 === p2) return ctx.reply("Can't compare a player with themselves!");

    const h2h = calcH2H(p1, p2, results, sessions);
    if (h2h.shared === 0) return ctx.reply(`${p1} and ${p2} haven't played together yet.`);

    let text = `\u{1F93C} <b>HEAD-TO-HEAD</b>\n\n`;
    text += `${dn(p1, players)}  vs  ${dn(p2, players)}\n`;
    text += `${h2h.shared} sessions together\n\n`;
    text += `<b>${p1}:</b> ${fmt(h2h.p1.net)} | ${h2h.p1.wins}W\n`;
    text += `<b>${p2}:</b> ${fmt(h2h.p2.net)} | ${h2h.p2.wins}W\n\n`;
    if (h2h.breakdown.length <= 10) {
      text += `<b>Session Breakdown:</b>\n`;
      h2h.breakdown.forEach((s) => {
        const p1e = s.p1pl >= 0 ? "\u{1F7E2}" : "\u{1F534}";
        const p2e = s.p2pl >= 0 ? "\u{1F7E2}" : "\u{1F534}";
        text += `S${s.num} ${s.date} — ${p1e} ${fmt(s.p1pl)} | ${p2e} ${fmt(s.p2pl)}\n`;
      });
    }
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("locations", async (ctx) => {
  try {
    const { sessions, results, players } = await getData();
    if (sessions.length === 0) return ctx.reply("No sessions yet.");
    const stats = calcLocationStats(sessions, results);
    let text = "\u{1F4CD} <b>LOCATION STATS</b>\n\n";
    stats.forEach((loc) => {
      text += `<b>${loc.location}</b>\n`;
      text += `   ${loc.sessionCount} sessions | Pot: $${loc.totalPot.toLocaleString()} | Avg: $${loc.avgPot.toLocaleString()}\n`;
      if (loc.bestPlayer) text += `   \u{1F451} Best: ${dn(loc.bestPlayer[0], players)} (${fmt(loc.bestPlayer[1])})\n`;
      if (loc.worstPlayer && loc.worstPlayer !== loc.bestPlayer) text += `   \u{1F4A9} Worst: ${dn(loc.worstPlayer[0], players)} (${fmt(loc.worstPlayer[1])})\n`;
      text += "\n";
    });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("hof", async (ctx) => {
  try {
    const { results, sessions, players } = await getData();
    const hof = calcHallOfFame(results);
    if (!hof) return ctx.reply("No results yet.");
    const bestSessNum = sessions.findIndex((s) => s.id === hof.best.sessionId) + 1;
    const worstSessNum = sessions.findIndex((s) => s.id === hof.worst.sessionId) + 1;
    let text = `\u{1F3C6} <b>HALL OF FAME</b>\n\n`;
    text += `\u{1F451} Best Single Session\n`;
    text += `   ${dn(hof.best.player, players)} — <b>${fmt(hof.best.amount)}</b> (S${bestSessNum})\n\n`;
    text += `\u{1F4A9} <b>HALL OF SHAME</b>\n\n`;
    text += `\u{1F480} Worst Single Session\n`;
    text += `   ${dn(hof.worst.player, players)} — <b>${fmt(hof.worst.amount)}</b> (S${worstSessNum})\n`;
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("trashtalk", async (ctx) => {
  try {
    const { results, sessions, players } = await getData();
    const msgs = generateTrashTalk(results, sessions, players);
    let text = "\u{1F525} <b>TRASH TALK</b>\n\n";
    msgs.forEach((m) => { text += `\u{2022} ${m}\n\n`; });
    ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("ifeellikepablo", (ctx) => {
  const quote = KANYE_QUOTES[Math.floor(Math.random() * KANYE_QUOTES.length)];
  ctx.reply(`\u{1F43B} <b>Ye says:</b>\n\n<i>"${quote}"</i>`, { parse_mode: "HTML" });
});

/* ══════════════════════════════════════════════
   WRITE COMMANDS (everyone)
   ══════════════════════════════════════════════ */

bot.command("rsvp", async (ctx) => {
  try {
    const data = await getData();
    if (!data.nextGame) return ctx.reply("No game scheduled. Use /schedule to create one.");
    const name = ctx.state.playerName;
    const game = data.nextGame;
    if (!game.confirmed) game.confirmed = [];
    if (!game.declined) game.declined = [];
    game.confirmed = game.confirmed.filter((p) => p !== name);
    game.declined = game.declined.filter((p) => p !== name);
    game.confirmed.push(name);
    await redis.set("gte:nextgame", JSON.stringify(game));
    const msg = `\u{2705} ${dn(name, data.players)} confirmed for ${game.date}`;
    ctx.reply(msg, { parse_mode: "HTML" });
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("cancelrsvp", async (ctx) => {
  try {
    const data = await getData();
    if (!data.nextGame) return ctx.reply("No game scheduled.");
    const name = ctx.state.playerName;
    const game = data.nextGame;
    if (!game.confirmed) game.confirmed = [];
    if (!game.declined) game.declined = [];
    const wasIn = game.confirmed.includes(name) || game.declined.includes(name);
    game.confirmed = game.confirmed.filter((p) => p !== name);
    game.declined = game.declined.filter((p) => p !== name);
    await redis.set("gte:nextgame", JSON.stringify(game));
    if (wasIn) {
      const msg = `\u{1F44B} ${dn(name, data.players)} removed RSVP for ${game.date}`;
      ctx.reply(msg, { parse_mode: "HTML" });
      notify(msg);
    } else {
      ctx.reply("You didn't have an RSVP to cancel.");
    }
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("schedule", async (ctx) => {
  conversations[ctx.from.id] = { type: "schedule", step: 0, data: {} };
  ctx.reply("\u{1F3AE} <b>Schedule Next Game</b>\n\nSend the date (YYYY-MM-DD):", { parse_mode: "HTML" });
});

bot.command("cancelschedule", async (ctx) => {
  try {
    const data = await getData();
    if (!data.nextGame) return ctx.reply("No game scheduled.");
    await redis.set("gte:nextgame", JSON.stringify(null));
    const msg = `\u{274C} Next game (${data.nextGame.date}) has been cancelled by ${dn(ctx.state.playerName, data.players)}.`;
    ctx.reply(msg, { parse_mode: "HTML" });
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("buyin", async (ctx) => {
  try {
    const amountStr = ctx.message.text.split(" ")[1];
    if (!amountStr) return ctx.reply("Usage: /buyin <amount>\nExample: /buyin 200");
    const amount = parseInt(amountStr.replace(/[$,]/g, ""));
    if (isNaN(amount) || amount <= 0) return ctx.reply("Send a valid dollar amount.");

    const data = await getData();
    if (data.sessions.length === 0) return ctx.reply("No active session. Ask an admin to create one with /newsession");
    const latest = data.sessions[data.sessions.length - 1];
    const name = ctx.state.playerName;

    const existing = data.results.find((r) => r.sessionId === latest.id && r.player === name);
    if (existing) {
      // Rebuy — must match original buy-in
      if (amount !== existing.buyIn) {
        return ctx.reply(`Rebuy must match your original buy-in of $${existing.buyIn}.\nUse /buyin ${existing.buyIn}`);
      }
      existing.rebuys += 1;
      await saveData(data);
      const msg = `\u{1F504} ${dn(name, data.players)} rebuy #${existing.rebuys} ($${existing.buyIn})\nTotal in: $${totalIn(existing)}`;
      ctx.reply(msg, { parse_mode: "HTML" });
      notify(msg);
    } else {
      // First buy-in
      const id = data.counters.nextRId || data.results.length + 1;
      const result = { id, sessionId: latest.id, player: name, buyIn: amount, rebuys: 0, cashOut: 0 };
      data.results.push(result);
      data.counters.nextRId = id + 1;
      await saveData(data);
      const sessNum = data.sessions.length;
      const msg = `\u{1F4B5} ${dn(name, data.players)} bought in for $${amount} (S${sessNum})`;
      ctx.reply(msg, { parse_mode: "HTML" });
      notify(msg);
    }
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("cashout", async (ctx) => {
  try {
    const amountStr = ctx.message.text.split(" ")[1];
    if (!amountStr) return ctx.reply("Usage: /cashout <amount>\nExample: /cashout 500");
    const amount = parseInt(amountStr.replace(/[$,]/g, ""));
    if (isNaN(amount) || amount < 0) return ctx.reply("Send a valid dollar amount.");

    const data = await getData();
    if (data.sessions.length === 0) return ctx.reply("No active session.");
    const latest = data.sessions[data.sessions.length - 1];
    const name = ctx.state.playerName;

    const existing = data.results.find((r) => r.sessionId === latest.id && r.player === name);
    if (!existing) return ctx.reply("You haven't bought in yet. Use /buyin <amount> first.");

    existing.cashOut = amount;
    await saveData(data);
    const n = pl(existing);
    const emoji = n >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    const msg = `${emoji} ${dn(name, data.players)} cashed out $${amount}\nP/L: <b>${fmt(n)}</b>`;
    ctx.reply(msg, { parse_mode: "HTML" });
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

/* ══════════════════════════════════════════════
   ADMIN COMMANDS
   ══════════════════════════════════════════════ */

bot.command("newsession", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("\u{1F6AB} Admin only.");
  conversations[ctx.from.id] = { type: "newsession", step: 0, data: {} };
  ctx.reply("\u{1F4C5} <b>New Session</b>\n\nSend the date (YYYY-MM-DD):", { parse_mode: "HTML" });
});

bot.command("addresult", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("\u{1F6AB} Admin only.");
  try {
    const { sessions } = await getData();
    if (sessions.length === 0) return ctx.reply("No sessions yet. Create one first with /newsession");
    conversations[ctx.from.id] = { type: "addresult", step: 0, data: {} };
    let sessionList = "Which session? Send the number:\n\n";
    sessions.forEach((s, i) => { sessionList += `<b>${i + 1}</b> \u{2014} ${s.date} (${s.gameType} ${s.stakes})\n`; });
    ctx.reply(`\u{1F4DD} <b>Add Result</b>\n\n${sessionList}`, { parse_mode: "HTML" });
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("delsession", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("\u{1F6AB} Admin only.");
  try {
    const num = parseInt(ctx.message.text.split(" ")[1]);
    const data = await getData();
    if (!num || num < 1 || num > data.sessions.length) return ctx.reply(`Usage: /delsession <1-${data.sessions.length}>`);
    const sess = data.sessions[num - 1];
    data.sessions = data.sessions.filter((s) => s.id !== sess.id);
    data.results = data.results.filter((r) => r.sessionId !== sess.id);
    await saveData(data);
    const msg = `\u{1F5D1} Deleted session S${num} (${sess.date} \u{2014} ${sess.gameType})`;
    ctx.reply(msg);
    notify(msg);
  } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command("delresult", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("\u{1F6AB} Admin only.");
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

/* ══════════════════════════════════════════════
   CONVERSATION HANDLER (multi-step input)
   ══════════════════════════════════════════════ */

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const conv = conversations[userId];
  if (!conv) return;
  const text = ctx.message.text.trim();

  try {
    /* ── Register flow ── */
    if (conv.type === "register") {
      if (conv.step === 0) {
        const { players } = await getData();
        const num = parseInt(text);
        if (!num || num < 1 || num > players.length) return ctx.reply(`Send a number 1-${players.length}:`);
        const chosen = players[num - 1];
        const tgMap = await getTgMap();
        const uid = String(ctx.from.id);
        // Check if name is taken by someone else
        const claimedBy = Object.entries(tgMap).find(([id, name]) => name === chosen.name && id !== uid);
        if (claimedBy) return ctx.reply(`${chosen.name} is already claimed by another user. Pick a different name.`);
        tgMap[uid] = chosen.name;
        await saveTgMap(tgMap);
        delete conversations[userId];
        ctx.reply(`\u{2705} Registered as <b>${chosen.avatar || "\u{1F3AD}"} ${chosen.name}</b>! You can now use all bot commands.`, { parse_mode: "HTML" });
        return;
      }
    }

    /* ── New Session flow (admin) ── */
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
        const msg = `\u{2705} Session S${data.sessions.length} created!\n\n\u{1F4C5} ${sess.date} | ${sess.host}\n\u{1F3AE} ${sess.gameType} ${sess.stakes}\n\u{1F4CD} ${sess.location}\n\nPlayers: use /buyin <amount> to join!`;
        ctx.reply(msg);
        notify(msg);
        return;
      }
    }

    /* ── Add Result flow (admin) ── */
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
        return ctx.reply("Buy-in amount ($):");
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
      if (conv.step === 1) { conv.data.time = text; conv.step = 2; return ctx.reply("Host:"); }
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
        const data = await getData();
        const msg = `\u{1F3AE} <b>GAME SCHEDULED!</b>\n\n\u{1F4C5} ${ng.date} at ${ng.time}\n\u{1F3E0} ${ng.host}\n\u{1F4CD} ${ng.location}\n\u{1F4B0} ${ng.stakes} | ${ng.gameType}\n\nScheduled by ${dn(ctx.state.playerName, data.players)}\n\nUse /rsvp to confirm!`;
        ctx.reply(msg, { parse_mode: "HTML" });
        notify(msg);
        return;
      }
    }
  } catch (e) {
    delete conversations[userId];
    ctx.reply(`Error: ${e.message}`);
  }
});

/* ══════════════════════════════════════════════
   LAUNCH
   ══════════════════════════════════════════════ */

console.log("ENV check — BOT_TOKEN set:", !!process.env.BOT_TOKEN, "REDIS_URL set:", !!process.env.REDIS_URL, "ADMIN_USERS:", process.env.ADMIN_USERS || "(none)");

async function startBot() {
  // Wait for old container to die during Railway deploys
  console.log("Waiting 15s for old container to shut down...");
  await new Promise((r) => setTimeout(r, 15000));

  // Verify token works
  const me = await bot.telegram.getMe();
  console.log(`Token OK: @${me.username}`);

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("Webhook deleted, pending updates dropped");

  // Launch with error catching — promise may never resolve on Railway
  bot.launch().then(() => {
    console.log("bot.launch() resolved");
  }).catch((err) => {
    console.error("bot.launch() error:", err.message);
  });

  // Wait a bit then verify polling is working
  await new Promise((r) => setTimeout(r, 3000));
  console.log("Bot should be polling now. Polling status:", bot.botInfo?.username || "unknown");
}

startBot().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

process.once("SIGINT", () => { bot.stop("SIGINT"); redis.disconnect(); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); redis.disconnect(); });
