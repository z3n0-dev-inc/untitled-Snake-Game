const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling'],
});

app.use(express.static(__dirname));
app.use(express.json());

// ============================================================
//  CONFIG
// ============================================================
const OWNER_PASSWORD  = 'Z3N0ISKING';
const ADMIN_PASS      = 'Z3N0ADMIN';
const MAP_SIZE        = 5000;         // Smaller map = more action
const ORB_COUNT       = 800;          // More orbs = faster, more satisfying growth
const TICK_MS         = 33;
const BROADCAST_MS    = 40;
const SNAKE_SPEED     = 3.4;          // Slightly faster base speed
const BOOST_SPEED     = 6.2;          // More satisfying boost
const SEG_DIST        = 11;
const INIT_LEN        = 8;
const GROW_PER_ORB    = 4;            // Grow faster for more satisfaction
const BOT_COUNT       = 5;            // 5 bots for constant action
const VIEW_RADIUS_SQ  = 2600 * 2600;
const MAX_PLAYERS     = 50;
const NEW_PLAYER_GRACE = 3000;        // 3s spawn protection

const OWNER_SKINS = new Set([
  'rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine',
  'z3n0_exclusive','death_god','cosmos','blood_moon','electric_god'
]);

// ============================================================
//  ACCOUNT DB
// ============================================================
const accountDB = {};
const playerDB  = {};
const crypto = require('crypto');
function hashPass(p) { return crypto.createHash('sha256').update(p + 'z3n0salt_ULTRA_2024').digest('hex'); }
function genAccountId() { return 'acc_' + uuidv4(); }

app.post('/api/account/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) return res.status(400).json({ error: 'All fields required.' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username 3-20 chars.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars.' });
  if (displayName.length < 2 || displayName.length > 20) return res.status(400).json({ error: 'Display name 2-20 chars.' });
  const key = username.toLowerCase().trim();
  if (accountDB[key]) return res.status(409).json({ error: 'Username taken.' });
  const accountId = genAccountId(), now = Date.now();
  accountDB[key] = { accountId, username: username.trim(), displayName: displayName.trim(), passwordHash: hashPass(password), createdAt: now, lastLogin: now };
  playerDB[accountId] = { id: accountId, name: displayName.trim(), coins: 750, totalScore: 0, totalKills: 0, gamesPlayed: 0, highScore: 0, unlockedCosmetics: ['title_rookie'], equippedTrail: null, equippedTitle: null, equippedBadge: null, firstSeen: now, lastSeen: now };
  res.json({ success: true, accountId, displayName: displayName.trim(), token: hashPass(accountId + password), profile: getProfileById(accountId) });
});

app.post('/api/account/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const key = username.toLowerCase().trim();
  const acc = accountDB[key];
  if (!acc) return res.status(401).json({ error: 'Account not found.' });
  if (acc.passwordHash !== hashPass(password)) return res.status(401).json({ error: 'Wrong password.' });
  acc.lastLogin = Date.now();
  const pr = getProfileById(acc.accountId);
  pr.lastSeen = Date.now();
  res.json({ success: true, accountId: acc.accountId, displayName: acc.displayName, token: hashPass(acc.accountId + password), profile: pr });
});

app.get('/api/account/profile/:accountId', (req, res) => {
  const pr = playerDB[req.params.accountId];
  if (!pr) return res.status(404).json({ error: 'Not found.' });
  res.json(pr);
});

function getProfileById(accountId) {
  if (!playerDB[accountId]) {
    playerDB[accountId] = { id: accountId, name: 'Snake', coins: 750, totalScore: 0, totalKills: 0, gamesPlayed: 0, highScore: 0, unlockedCosmetics: ['title_rookie'], equippedTrail: null, equippedTitle: null, equippedBadge: null, firstSeen: Date.now(), lastSeen: Date.now() };
  }
  return playerDB[accountId];
}

function getProfile(accountId, name) {
  const key = accountId || ('guest:' + (name || '').toLowerCase().trim());
  if (!playerDB[key]) {
    playerDB[key] = { id: key, name: name || 'Snake', coins: 750, totalScore: 0, totalKills: 0, gamesPlayed: 0, highScore: 0, unlockedCosmetics: ['title_rookie'], equippedTrail: null, equippedTitle: null, equippedBadge: null, firstSeen: Date.now(), lastSeen: Date.now(), isGuest: !accountId };
  }
  const p = playerDB[key];
  p.lastSeen = Date.now();
  if (name && p.name !== name) p.name = name;
  return p;
}

// ============================================================
//  COSMETICS
// ============================================================
let PLAYFAB_CATALOG = { Catalog: [] };
try { PLAYFAB_CATALOG = require('./Z3N0_PlayFab_Catalog.json'); } catch(e) { console.log('[INFO] No PlayFab catalog JSON, using fallback.'); }

const COSMETICS = {};
for (const item of PLAYFAB_CATALOG.Catalog) {
  let custom = {};
  try { custom = JSON.parse(item.CustomData || '{}'); } catch(e) {}
  COSMETICS[item.ItemId] = {
    id: item.ItemId, type: custom.type || 'badge', name: item.DisplayName,
    price: item.VirtualCurrencyPrices?.GC ?? 0, emoji: custom.emoji || '?',
    glow: custom.glow || null, text: custom.text || null,
    rarity: custom.rarity || 'common', ownerOnly: custom.ownerOnly === true, tags: item.Tags || [],
  };
}
if (!COSMETICS['title_rookie']) {
  COSMETICS['title_rookie'] = { id: 'title_rookie', type: 'title', name: '[ROOKIE]', price: 0, emoji: '🐍', text: '[ROOKIE]', rarity: 'common', ownerOnly: false };
}

// ============================================================
//  GAME STATE
// ============================================================
let players = {}, orbs = {}, powerUps = {}, portals = {};
let activeEvent = null, leaderboard = [], serverKillFeed = [], globalKillCount = 0;
let dailyTopKiller = { name: null, kills: 0 };

// ============================================================
//  ORBS  (added mega orbs)
// ============================================================
const ORB_COLORS = [
  '#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff',
  '#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff',
  '#00ff88','#ff3366','#66ffcc','#ffaa00','#aa00ff',
  '#ff55cc','#55ffcc','#ccff55',
];

function mkOrb(x, y, golden, mega) {
  const isGolden = golden || Math.random() < 0.012;
  const isMega = mega || (!isGolden && Math.random() < 0.004);
  return {
    id: uuidv4(),
    x: x !== undefined ? x : Math.random() * MAP_SIZE,
    y: y !== undefined ? y : Math.random() * MAP_SIZE,
    color: isMega ? '#ff00ff' : isGolden ? '#ffdd00' : ORB_COLORS[Math.random() * ORB_COLORS.length | 0],
    size: isMega ? 16 : isGolden ? 12 : Math.random() * 5 + 4,
    value: isMega ? 20 : isGolden ? 8 : (Math.random() * 3 | 0) + 1,
    golden: isGolden, mega: isMega,
  };
}

for (let i = 0; i < ORB_COUNT; i++) { const o = mkOrb(); orbs[o.id] = o; }
for (let i = 0; i < 12; i++) { const o = mkOrb(undefined, undefined, true); orbs[o.id] = o; }
for (let i = 0; i < 4; i++) { const o = mkOrb(undefined, undefined, false, true); orbs[o.id] = o; }

function mkSegs(x, y, len) {
  const a = [];
  for (let i = 0; i < len; i++) a.push({ x: x - i * SEG_DIST, y });
  return a;
}

function dsq(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

// ============================================================
//  POWER-UPS  (added 'rage' and 'shrink')
// ============================================================
const PU_TYPES = ['speed', 'shield', 'ghost', 'magnet', 'bomb', 'freeze', 'grow', 'star', 'rage', 'shrink'];
const PU_CONFIG = {
  speed:  { duration: 7000,  color: '#ffcc00', emoji: '⚡' },
  shield: { duration: 10000, color: '#00aaff', emoji: '🛡️' },
  ghost:  { duration: 6000,  color: '#94a3b8', emoji: '👻' },
  magnet: { duration: 9000,  color: '#c084fc', emoji: '🧲' },
  bomb:   { duration: 0,     color: '#ff4400', emoji: '💥' },
  freeze: { duration: 4500,  color: '#06b6d4', emoji: '❄️' },
  grow:   { duration: 0,     color: '#00ff88', emoji: '🍄' },
  star:   { duration: 8000,  color: '#fbbf24', emoji: '⭐' },
  rage:   { duration: 5000,  color: '#ff0055', emoji: '🔥' },
  shrink: { duration: 0,     color: '#ff88cc', emoji: '✂️' },
};

function spawnPowerUp(nearX, nearY) {
  const id = uuidv4();
  const type = PU_TYPES[Math.random() * PU_TYPES.length | 0];
  const margin = 600;
  const x = nearX !== undefined
    ? Math.max(margin, Math.min(MAP_SIZE - margin, nearX + (Math.random() - 0.5) * 400))
    : margin + Math.random() * (MAP_SIZE - margin * 2);
  const y = nearY !== undefined
    ? Math.max(margin, Math.min(MAP_SIZE - margin, nearY + (Math.random() - 0.5) * 400))
    : margin + Math.random() * (MAP_SIZE - margin * 2);
  powerUps[id] = { id, type, x, y, spawnedAt: Date.now() };
  io.emit('powerUpSpawned', powerUps[id]);
}

for (let i = 0; i < 14; i++) spawnPowerUp();

// ============================================================
//  PORTALS
// ============================================================
function spawnPortalPair() {
  const id1 = uuidv4(), id2 = uuidv4();
  const margin = 500;
  const p1 = { id: id1, linkedId: id2, x: margin + Math.random() * (MAP_SIZE - margin * 2), y: margin + Math.random() * (MAP_SIZE - margin * 2), color: '#a855f7', cooldowns: {} };
  const p2 = { id: id2, linkedId: id1, x: margin + Math.random() * (MAP_SIZE - margin * 2), y: margin + Math.random() * (MAP_SIZE - margin * 2), color: '#a855f7', cooldowns: {} };
  while (dsq(p1, p2) < 1000 * 1000) { p2.x = margin + Math.random() * (MAP_SIZE - margin * 2); p2.y = margin + Math.random() * (MAP_SIZE - margin * 2); }
  portals[id1] = p1; portals[id2] = p2;
  io.emit('portalsSpawned', [p1, p2]);
  setTimeout(() => {
    delete portals[id1]; delete portals[id2];
    io.emit('portalsRemoved', [id1, id2]);
    setTimeout(spawnPortalPair, 12000 + Math.random() * 18000);
  }, 40000);
}
setTimeout(spawnPortalPair, 15000);

// ============================================================
//  AI BOTS — diverse personalities
// ============================================================
const BOT_PROFILES = [
  { name: 'Viper',       skin: 'fire',     aggression: 0.95, style: 'hunter',    tauntRate: 0.4  },
  { name: 'Phantom',     skin: 'midnight', aggression: 0.50, style: 'ambusher',  tauntRate: 0.1  },
  { name: 'Coil',        skin: 'toxic',    aggression: 0.65, style: 'orbhunter', tauntRate: 0.2  },
  { name: 'NightShade',  skin: 'ice',      aggression: 0.80, style: 'hunter',    tauntRate: 0.3  },
  { name: 'Taipan',      skin: 'lava',     aggression: 0.70, style: 'orbhunter', tauntRate: 0.15 },
  { name: 'Nexus',       skin: 'electric', aggression: 0.85, style: 'ambusher',  tauntRate: 0.25 },
  { name: 'Mamba',       skin: 'gold',     aggression: 0.60, style: 'hunter',    tauntRate: 0.2  },
];

const BOT_TAUNTS = [
  'get rekt 😂', 'too slow!', 'catch me if you can', 'gg no re',
  'skill issue', 'L + ratio', "you're food", 'not even close',
  'ez clap', 'is that all?', 'come get some', 'back to the menu',
];

function mkBot(profileIdx) {
  const profile = BOT_PROFILES[profileIdx % BOT_PROFILES.length];
  const cx = MAP_SIZE / 2, cy = MAP_SIZE / 2;
  const x = cx + (Math.random() - 0.5) * 1400;
  const y = cy + (Math.random() - 0.5) * 1400;
  return {
    id: 'bot_' + uuidv4(), socketId: null, isBot: true,
    name: profile.name, skin: profile.skin,
    grantedSkin: null, playfabId: null, accountId: null,
    segments: mkSegs(x, y, INIT_LEN * 6),
    angle: Math.random() * Math.PI * 2,
    speed: SNAKE_SPEED, boosting: false,
    growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
    width: 8, dead: false, alive: true, isOwner: false, effect: null,
    equippedTrail: null, equippedTitle: '[BOT]', equippedBadge: '🤖',
    unlockedCosmetics: [], activePowerUps: {}, ghostUntil: 0, shieldActive: false, killStreak: 0,
    _profile: profile,
    _turnTimer: 0, _boostTimer: 0, _wanderAngle: Math.random() * Math.PI * 2,
    _tauntTimer: 150 + Math.random() * 250 | 0,
    _stuckTimer: 0, _prevX: x, _prevY: y,
  };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function tickBot(bot) {
  const h = bot.segments[0];
  const profile = bot._profile;
  bot._turnTimer--;
  bot._boostTimer--;
  bot._tauntTimer--;

  // Anti-stuck detection
  if (dsq(h, { x: bot._prevX, y: bot._prevY }) < 4) bot._stuckTimer++;
  else { bot._stuckTimer = 0; bot._prevX = h.x; bot._prevY = h.y; }
  if (bot._stuckTimer > 30) { bot._wanderAngle += Math.PI * 0.8; bot._stuckTimer = 0; }

  // Wall avoidance
  const M = 350;
  if (h.x < M)               bot.angle = lerpAngle(bot.angle, 0, 0.4);
  else if (h.x > MAP_SIZE-M) bot.angle = lerpAngle(bot.angle, Math.PI, 0.4);
  if (h.y < M)               bot.angle = lerpAngle(bot.angle, Math.PI/2, 0.4);
  else if (h.y > MAP_SIZE-M) bot.angle = lerpAngle(bot.angle, -Math.PI/2, 0.4);

  // Near power-up
  let nearPU = null, nearPUD = 400 * 400;
  for (const pid in powerUps) {
    const pu = powerUps[pid], d = dsq(h, pu);
    if (d < nearPUD) { nearPUD = d; nearPU = pu; }
  }

  // Find nearest human
  const arr = Object.values(players);
  let huntTarget = null, huntD = Infinity;
  for (const other of arr) {
    if (other.id === bot.id || other.dead || other.isBot || !other.segments.length) continue;
    if (other._graceUntil && Date.now() < other._graceUntil) continue;
    const d = dsq(h, other.segments[0]);
    if (d < huntD) { huntD = d; huntTarget = other; }
  }

  // Evade much-bigger snakes nearby
  let evadeTarget = null;
  for (const other of arr) {
    if (other.id === bot.id || other.dead || !other.segments.length) continue;
    const d = dsq(h, other.segments[0]);
    if (d < 180 * 180 && other.segments.length > bot.segments.length * 1.4) { evadeTarget = other; break; }
  }

  const aggrRange = profile.aggression > 0.8 ? 1600 * 1600 : 1000 * 1000;

  if (evadeTarget) {
    bot.angle = lerpAngle(bot.angle, Math.atan2(h.y - evadeTarget.segments[0].y, h.x - evadeTarget.segments[0].x), 0.35);
    bot.boosting = bot.segments.length > INIT_LEN * 3;
  } else if (huntTarget && huntD < aggrRange && Math.random() < profile.aggression) {
    const th = huntTarget.segments[0];
    if (profile.style === 'ambusher' && huntD > 400 * 400) {
      // Predict intercept position
      const px = th.x + Math.cos(huntTarget.angle) * 60;
      const py = th.y + Math.sin(huntTarget.angle) * 60;
      bot.angle = lerpAngle(bot.angle, Math.atan2(py - h.y, px - h.x), 0.20);
    } else {
      bot.angle = lerpAngle(bot.angle, Math.atan2(th.y - h.y, th.x - h.x), 0.24);
    }
    bot.boosting = huntD < 350 * 350 && bot.segments.length > INIT_LEN * 2;
  } else if (nearPU && Math.random() < 0.55) {
    bot.angle = lerpAngle(bot.angle, Math.atan2(nearPU.y - h.y, nearPU.x - h.x), 0.20);
    bot.boosting = nearPUD < 120 * 120;
  } else {
    // Orb hunt (orbhunters prefer golden orbs)
    let nearOrb = null, nearD = 700 * 700;
    for (const oid in orbs) {
      const o = orbs[oid];
      const weight = profile.style === 'orbhunter' && o.golden ? 0.3 : 1;
      const d = dsq(h, o) * weight;
      if (d < nearD) { nearD = d; nearOrb = o; }
    }
    if (nearOrb) {
      bot.angle = lerpAngle(bot.angle, Math.atan2(nearOrb.y - h.y, nearOrb.x - h.x), 0.14);
    } else {
      if (bot._turnTimer <= 0) { bot._wanderAngle += (Math.random() - 0.5) * 1.2; bot._turnTimer = 40 + Math.random() * 80 | 0; }
      bot.angle = lerpAngle(bot.angle, bot._wanderAngle, 0.09);
    }
    if (bot._boostTimer <= 0) { bot.boosting = Math.random() < 0.08; bot._boostTimer = 30 + Math.random() * 60 | 0; }
  }

  if (bot._tauntTimer <= 0 && bot.kills > 0 && Math.random() < profile.tauntRate) {
    io.emit('botTaunt', { botId: bot.id, name: bot.name, message: BOT_TAUNTS[Math.random() * BOT_TAUNTS.length | 0] });
    bot._tauntTimer = 350 + Math.random() * 500 | 0;
  }
}

function respawnBot(bot) {
  const humans = Object.values(players).filter(p => !p.isBot && !p.dead && p.segments.length);
  let x, y;
  if (humans.length) {
    const t = humans[Math.random() * humans.length | 0].segments[0];
    x = Math.max(400, Math.min(MAP_SIZE - 400, t.x + (Math.random() - 0.5) * 900));
    y = Math.max(400, Math.min(MAP_SIZE - 400, t.y + (Math.random() - 0.5) * 900));
  } else {
    x = MAP_SIZE / 2 + (Math.random() - 0.5) * 1200;
    y = MAP_SIZE / 2 + (Math.random() - 0.5) * 1200;
  }
  bot.segments = mkSegs(x, y, INIT_LEN * 6);
  bot.angle = Math.random() * Math.PI * 2;
  bot.dead = false; bot.alive = true;
  bot.score = 0; bot.sessionCoins = 0;
  bot.growBuffer = 0; bot.width = 8; bot.boosting = false;
  bot.activePowerUps = {}; bot.ghostUntil = 0; bot.shieldActive = false; bot.killStreak = 0;
  bot._stuckTimer = 0; bot._prevX = x; bot._prevY = y;
}

for (let i = 0; i < BOT_COUNT; i++) { const b = mkBot(i); players[b.id] = b; }

// ============================================================
//  KILL
// ============================================================
function killPlayer(player, killer) {
  if (player.dead) return;
  player.dead = true;
  globalKillCount++;

  if (!player.isBot && player.socketId) {
    const pr = getProfile(player.accountId || player.playfabId, player.name);
    pr.totalScore += player.score;
    pr.coins += player.sessionCoins;
    pr.gamesPlayed++;
    if (player.score > pr.highScore) pr.highScore = player.score;
  }

  // Drop orbs generously
  const dropN = Math.min(Math.floor(player.segments.length / 2), 100);
  const dropped = [];
  for (let i = 0; i < dropN; i++) {
    const seg = player.segments[Math.random() * player.segments.length | 0];
    const o = mkOrb(seg.x + (Math.random() - 0.5) * 50, seg.y + (Math.random() - 0.5) * 50);
    o.size = 9; o.value = 2; o.color = '#ffaa33';
    orbs[o.id] = o; dropped.push(o);
  }

  io.emit('playerDied', { id: player.id, killerName: killer ? killer.name : 'the wall', droppedOrbs: dropped, position: player.segments[0], length: player.segments.length });

  if (killer) {
    const baseCoins = Math.floor(player.score * 0.2) + 15;
    killer.score += Math.floor(player.score * 0.35) + player.segments.length;
    killer.sessionCoins += baseCoins;
    killer.kills = (killer.kills || 0) + 1;
    killer.killStreak = (killer.killStreak || 0) + 1;

    if (!killer.isBot && killer.kills > dailyTopKiller.kills) {
      dailyTopKiller = { name: killer.name, kills: killer.kills };
    }

    if (!killer.isBot) {
      const pr = getProfile(killer.accountId || killer.playfabId, killer.name);
      pr.totalKills++;
      if (killer.killStreak >= 3) {
        const bonus = killer.killStreak * 12;
        killer.sessionCoins += bonus; pr.coins += bonus;
        io.to(killer.socketId).emit('killStreakBonus', { streak: killer.killStreak, bonusCoins: bonus });
      }
    }
    if (killer.socketId) {
      io.to(killer.socketId).emit('killConfirmed', { victimName: player.name, coinsGained: baseCoins, streak: killer.killStreak, victimLength: player.segments.length });
    }

    const kfEntry = { id: uuidv4(), killer: killer.name, victim: player.name, killerId: killer.id, victimId: player.id, isBot: killer.isBot, ts: Date.now() };
    serverKillFeed.unshift(kfEntry);
    serverKillFeed = serverKillFeed.slice(0, 8);
    io.emit('killFeedUpdate', kfEntry);
  }

  if (!player.isBot && player.socketId) {
    io.to(player.socketId).emit('youDied', { killerName: killer ? killer.name : 'the wall', coinsEarned: player.sessionCoins, score: player.score, length: player.segments.length, kills: player.kills || 0 });
    player.sessionCoins = 0;
    setTimeout(() => { delete players[player.id]; io.emit('playerLeft', player.id); }, 1000);
  } else if (player.isBot) {
    setTimeout(() => respawnBot(player), 1500 + Math.random() * 2500);
  }
}

// ============================================================
//  POWER-UP APPLY
// ============================================================
function checkPowerUpPickup(p) {
  const h = p.segments[0];
  for (const pid in powerUps) {
    const pu = powerUps[pid];
    if (dsq(h, pu) < 45 * 45) {
      applyPowerUp(p, pu);
      delete powerUps[pid];
      io.emit('powerUpCollected', { puId: pid, playerId: p.id, type: pu.type });
      setTimeout(() => spawnPowerUp(pu.x, pu.y), 6000 + Math.random() * 10000);
      break;
    }
  }
}

function applyPowerUp(p, pu) {
  const cfg = PU_CONFIG[pu.type];
  const now = Date.now();
  if (!p.activePowerUps) p.activePowerUps = {};

  switch (pu.type) {
    case 'bomb': {
      let killed = 0;
      for (const other of Object.values(players)) {
        if (other.id === p.id || other.dead || !other.segments.length) continue;
        if (dsq(p.segments[0], other.segments[0]) < 350 * 350) {
          if (!other.shieldActive) { killPlayer(other, p); killed++; }
          else { other.shieldActive = false; if (other.activePowerUps) delete other.activePowerUps.shield; if (other.socketId) io.to(other.socketId).emit('shieldPopped', {}); }
        }
      }
      io.emit('bombExploded', { x: p.segments[0].x, y: p.segments[0].y, playerId: p.id, killed });
      break;
    }
    case 'grow':
      for (let i = 0; i < 60 * SEG_DIST; i++) { const t = p.segments[p.segments.length-1]; p.segments.push({ x: t.x, y: t.y }); }
      p.score += 40;
      break;
    case 'shrink': {
      // Shrink the nearest non-ghost rival
      let nearest = null, nd = Infinity;
      for (const other of Object.values(players)) {
        if (other.id === p.id || other.dead || !other.segments.length) continue;
        const d = dsq(p.segments[0], other.segments[0]);
        if (d < nd) { nd = d; nearest = other; }
      }
      if (nearest && nearest.segments.length > INIT_LEN * SEG_DIST) {
        nearest.segments = nearest.segments.slice(0, Math.max(INIT_LEN * SEG_DIST, nearest.segments.length * 0.6 | 0));
        if (nearest.socketId) io.to(nearest.socketId).emit('systemMessage', '✂️ You were shrunk by someone!');
        if (!p.isBot && p.socketId) io.to(p.socketId).emit('systemMessage', '✂️ Shrunk ' + nearest.name + '!');
      }
      break;
    }
    case 'rage':
      p.activePowerUps.rage = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      p.speed = SNAKE_SPEED * 2.2;
      break;
    case 'freeze':
      for (const other of Object.values(players)) {
        if (other.id === p.id) continue;
        if (!other.activePowerUps) other.activePowerUps = {};
        other.activePowerUps.frozen = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      }
      io.emit('freezeActivated', { playerId: p.id, duration: cfg.duration });
      break;
    case 'star':
      p.activePowerUps.star = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      p.speed = SNAKE_SPEED * 1.35;
      break;
    case 'speed':
      p.activePowerUps.speed = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      p.speed = SNAKE_SPEED * 1.9;
      break;
    case 'shield':
      p.shieldActive = true;
      p.activePowerUps.shield = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      setTimeout(() => { p.shieldActive = false; if (p.activePowerUps) delete p.activePowerUps.shield; }, cfg.duration);
      break;
    case 'ghost':
      p.activePowerUps.ghost = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      p.ghostUntil = now + cfg.duration;
      break;
    case 'magnet':
      p.activePowerUps.magnet = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      break;
  }

  // Cleanup timed effects
  if (cfg.duration > 0 && !['star','speed','shield','rage'].includes(pu.type)) {
    setTimeout(() => { if (p.activePowerUps) delete p.activePowerUps[pu.type]; }, cfg.duration);
  }
  if (['star','speed','rage'].includes(pu.type) && cfg.duration > 0) {
    setTimeout(() => { if (!p.dead) p.speed = SNAKE_SPEED; if (p.activePowerUps) delete p.activePowerUps[pu.type]; }, cfg.duration);
  }

  if (!p.isBot && p.socketId) {
    io.to(p.socketId).emit('powerUpActivated', { type: pu.type, duration: cfg.duration, emoji: cfg.emoji });
  }
}

// ============================================================
//  PORTALS
// ============================================================
function checkPortals(p) {
  const h = p.segments[0];
  for (const pid in portals) {
    const portal = portals[pid];
    if (portal.cooldowns[p.id] && Date.now() < portal.cooldowns[p.id]) continue;
    if (dsq(h, portal) < 48 * 48) {
      const dest = portals[portal.linkedId];
      if (!dest) continue;
      const nx = dest.x + Math.cos(p.angle) * 65, ny = dest.y + Math.sin(p.angle) * 65;
      const sx = nx - h.x, sy = ny - h.y;
      p.segments = p.segments.map(s => ({ x: s.x + sx, y: s.y + sy }));
      portal.cooldowns[p.id] = Date.now() + 2000;
      dest.cooldowns[p.id] = Date.now() + 2000;
      if (!p.isBot && p.socketId) io.to(p.socketId).emit('teleported', { from: pid, to: portal.linkedId });
      io.emit('portalUsed', { playerId: p.id, portalId: pid, destId: portal.linkedId });
      break;
    }
  }
}

// ============================================================
//  MAGNET
// ============================================================
function applyMagnet(p) {
  if (!p.activePowerUps?.magnet || Date.now() >= p.activePowerUps.magnet.until) return;
  const h = p.segments[0];
  for (const oid in orbs) {
    const o = orbs[oid], d2 = dsq(h, o);
    if (d2 < 320 * 320 && d2 > 1) { const d = Math.sqrt(d2), pull = Math.min(500 / d, 5); o.x += (h.x - o.x) / d * pull; o.y += (h.y - o.y) / d * pull; }
  }
}

// ============================================================
//  COLLISION
// ============================================================
function checkCollisions() {
  const arr = Object.values(players);
  const now = Date.now();
  for (const p of arr) {
    if (p.dead) continue;
    const h = p.segments[0];
    const isGhost = p.ghostUntil && now < p.ghostUntil;
    const inGrace = p._graceUntil && now < p._graceUntil;

    if (h.x < -10 || h.x > MAP_SIZE + 10 || h.y < -10 || h.y > MAP_SIZE + 10) { killPlayer(p, null); continue; }
    if (p.activePowerUps?.frozen && now > p.activePowerUps.frozen.until) { delete p.activePowerUps.frozen; p.speed = SNAKE_SPEED; }

    // Orb pickup
    for (const oid in orbs) {
      const o = orbs[oid];
      const r = p.width + o.size;
      if (dsq(h, o) < r * r) {
        p.growBuffer += GROW_PER_ORB * o.value;
        p.score += o.value;
        p.sessionCoins += Math.ceil(o.value / 3);
        delete orbs[oid];
        const neo = mkOrb(); orbs[neo.id] = neo;
        io.emit('orbEaten', { oid, newOrb: neo, eaterId: p.id, golden: o.golden, mega: o.mega });
        break;
      }
    }
    if (p.dead) continue;

    checkPowerUpPickup(p);
    checkPortals(p);
    applyMagnet(p);

    if (isGhost || inGrace) continue;

    // Snake vs snake collisions
    for (const other of arr) {
      if (other.id === p.id || other.dead) continue;
      const otherGhost = other.ghostUntil && now < other.ghostUntil;
      if (otherGhost) continue;
      const segs = other.segments;

      // Body collision
      for (let si = 4; si < segs.length; si += (si < 25 ? 1 : 2)) {
        const r = p.width + other.width - 5;
        if (dsq(h, segs[si]) < r * r) {
          if (p.shieldActive) { p.shieldActive = false; if (p.activePowerUps) delete p.activePowerUps.shield; if (p.socketId) io.to(p.socketId).emit('shieldPopped', {}); break; }
          killPlayer(p, other); break;
        }
      }
      if (p.dead) break;

      // Head-on — rage wins; smaller loses; equal = no kill
      const r2 = p.width + other.width;
      if (dsq(h, segs[0]) < r2 * r2) {
        const pRage = p.activePowerUps?.rage && now < (p.activePowerUps.rage?.until || 0);
        const oRage = other.activePowerUps?.rage && now < (other.activePowerUps.rage?.until || 0);
        if (pRage && !oRage) {
          if (!other.shieldActive) killPlayer(other, p);
          else { other.shieldActive = false; if (other.socketId) io.to(other.socketId).emit('shieldPopped', {}); }
        } else if (oRage && !pRage) {
          if (p.shieldActive) { p.shieldActive = false; if (p.socketId) io.to(p.socketId).emit('shieldPopped', {}); }
          else killPlayer(p, other);
        } else if (p.segments.length < other.segments.length) {
          if (p.shieldActive) { p.shieldActive = false; if (p.socketId) io.to(p.socketId).emit('shieldPopped', {}); }
          else killPlayer(p, other);
        }
        // Equal size: both survive (bounce effect emerges naturally)
      }
      if (p.dead) break;
    }
  }
}

// ============================================================
//  GAME TICK
// ============================================================
function gameTick() {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    if (p.dead || !p.alive) continue;
    if (p.isBot) tickBot(p);

    const frozen = p.activePowerUps?.frozen && now < p.activePowerUps.frozen.until;
    const spd = frozen ? SNAKE_SPEED * 0.3 : (p.boosting ? BOOST_SPEED : (p.speed || SNAKE_SPEED));
    const h = p.segments[0];
    p.segments.unshift({ x: h.x + Math.cos(p.angle) * spd, y: h.y + Math.sin(p.angle) * spd });

    if (p.growBuffer > 0) p.growBuffer--;
    else p.segments.pop();

    // Boosting slightly shrinks snake for strategic depth
    if (p.boosting && p.segments.length > INIT_LEN * SEG_DIST * 2 && Math.random() < 0.18) {
      const tail = p.segments[p.segments.length - 1];
      const o = mkOrb(tail.x, tail.y); o.size = 7; o.value = 1;
      orbs[o.id] = o; p.segments.pop();
    }

    p.width = Math.max(6, Math.min(28, 6 + p.segments.length * 0.022));
  }
  checkCollisions();

  leaderboard = Object.values(players).filter(p => !p.dead)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, length: p.segments.length, score: p.score,
      skin: p.skin, isOwner: p.isOwner, isBot: p.isBot || false,
      equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge, killStreak: p.killStreak || 0,
    }));
}

setInterval(gameTick, TICK_MS);

// ============================================================
//  STATE BROADCAST
// ============================================================
function buildState(p) {
  let segs = p.segments;
  if (segs.length > 140) segs = segs.filter((_, i) => i < 30 || i % 2 === 0);
  return {
    segments: segs, angle: p.angle, skin: p.skin, grantedSkin: p.grantedSkin || null,
    name: p.name, width: p.width, boosting: p.boosting,
    isOwner: p.isOwner, isBot: p.isBot || false,
    equippedTrail: p.equippedTrail || null, equippedTitle: p.equippedTitle || null, equippedBadge: p.equippedBadge || null,
    activePowerUps: p.activePowerUps || {}, ghostUntil: p.ghostUntil || 0, shieldActive: p.shieldActive || false,
    killStreak: p.killStreak || 0, score: p.score,
    raging: !!(p.activePowerUps?.rage && Date.now() < (p.activePowerUps.rage?.until || 0)),
    inGrace: !!(p._graceUntil && Date.now() < p._graceUntil),
  };
}

setInterval(() => {
  const alive = Object.values(players).filter(p => !p.dead);
  for (const pid in players) {
    const me = players[pid];
    if (me.isBot || !me.socketId || me.dead) continue;
    const mh = me.segments[0];
    if (!mh) continue;
    const state = {}; state[me.id] = buildState(me);
    for (const p of alive) {
      if (p.id === me.id) continue;
      if (p.isBot || dsq(mh, p.segments[0]) <= VIEW_RADIUS_SQ) state[p.id] = buildState(p);
    }
    io.to(me.socketId).emit('gameState', { players: state, leaderboard, activeEvent, powerUps: Object.values(powerUps), portals: Object.values(portals), myCoins: me.sessionCoins });
  }
}, BROADCAST_MS);

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', socket => {

  socket.on('joinGame', ({ name, skin, password, playfabId, accountId }) => {
    const humanCount = Object.values(players).filter(p => !p.isBot && !p.dead).length;
    if (humanCount >= MAX_PLAYERS) { socket.emit('serverFull', { message: 'Server full!' }); return; }

    const isOwner = password === OWNER_PASSWORD;
    const safeSkin = isOwner ? skin : (OWNER_SKINS.has(skin) ? 'classic' : skin);
    const cx = MAP_SIZE / 2, cy = MAP_SIZE / 2;
    const x = cx + (Math.random() - 0.5) * 1800, y = cy + (Math.random() - 0.5) * 1800;
    const profileKey = accountId || playfabId || null;
    const pr = getProfile(profileKey, name);

    const player = {
      id: uuidv4(), socketId: socket.id, isBot: false,
      name: pr.name || name || 'Snake', skin: safeSkin, grantedSkin: null,
      playfabId: playfabId || null, accountId: accountId || null,
      segments: mkSegs(x, y, INIT_LEN),
      angle: 0, speed: SNAKE_SPEED, boosting: false,
      growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
      width: 8, dead: false, alive: true, isOwner, effect: null,
      equippedTrail: pr.equippedTrail, equippedTitle: isOwner ? '[Z3N0]' : pr.equippedTitle,
      equippedBadge: isOwner ? '👑' : pr.equippedBadge,
      unlockedCosmetics: isOwner ? Object.keys(COSMETICS) : [...(pr.unlockedCosmetics || ['title_rookie'])],
      activePowerUps: {}, ghostUntil: 0, shieldActive: false, killStreak: 0,
      _graceUntil: Date.now() + NEW_PLAYER_GRACE,
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined', {
      playerId: player.id, isOwner, mapSize: MAP_SIZE,
      orbs: Object.values(orbs), powerUps: Object.values(powerUps), portals: Object.values(portals),
      killFeed: serverKillFeed,
      profile: { coins: pr.coins, totalScore: pr.totalScore, totalKills: pr.totalKills, gamesPlayed: pr.gamesPlayed, highScore: pr.highScore, unlockedCosmetics: player.unlockedCosmetics, equippedTrail: player.equippedTrail, equippedTitle: player.equippedTitle, equippedBadge: player.equippedBadge, isGuest: !accountId && !playfabId },
      cosmeticsCatalog: COSMETICS,
      graceMs: NEW_PLAYER_GRACE,
    });

    io.emit('playerJoined', { id: player.id, name: player.name, isOwner });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.playerId];
    if (!p || p.dead) return;
    p.angle = angle; p.boosting = !!boosting;
  });

  socket.on('buyCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId]; if (!p) return;
    const c = COSMETICS[cosmeticId];
    if (!c) { socket.emit('cosmeticError', 'Item not found.'); return; }
    if (c.ownerOnly) { socket.emit('cosmeticError', 'Owner-only!'); return; }
    const pr = getProfile(p.accountId || p.playfabId, p.name);
    if (pr.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError', 'Already owned!'); return; }
    if (c.price > 0) {
      const total = pr.coins + p.sessionCoins;
      if (total < c.price) { socket.emit('cosmeticError', `Need ${c.price} coins`); return; }
      let rem = c.price;
      if (p.sessionCoins >= rem) p.sessionCoins -= rem;
      else { rem -= p.sessionCoins; p.sessionCoins = 0; pr.coins -= rem; }
    }
    pr.unlockedCosmetics.push(cosmeticId);
    p.unlockedCosmetics.push(cosmeticId);
    socket.emit('cosmeticBought', { cosmeticId, newCoinBalance: pr.coins + p.sessionCoins, unlockedCosmetics: pr.unlockedCosmetics });
  });

  socket.on('equipCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId]; if (!p) return;
    const c = COSMETICS[cosmeticId]; if (!c) return;
    if (c.ownerOnly && !p.isOwner) { socket.emit('cosmeticError', 'Owner-only!'); return; }
    if (!p.isOwner && !p.unlockedCosmetics.includes(cosmeticId) && c.price > 0) { socket.emit('cosmeticError', "You don't own this!"); return; }
    const pr = getProfile(p.accountId || p.playfabId, p.name);
    if (c.type === 'trail') { p.equippedTrail = cosmeticId; pr.equippedTrail = cosmeticId; }
    else if (c.type === 'title') { const txt = c.text || c.name; p.equippedTitle = txt; pr.equippedTitle = txt; }
    else if (c.type === 'badge') { p.equippedBadge = c.emoji; pr.equippedBadge = c.emoji; }
    socket.emit('cosmeticEquipped', { cosmeticId, equippedTrail: p.equippedTrail, equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge });
  });

  socket.on('unequipCosmetic', ({ slot }) => {
    const p = players[socket.playerId]; if (!p) return;
    const pr = getProfile(p.accountId || p.playfabId, p.name);
    if (slot === 'trail') { p.equippedTrail = null; pr.equippedTrail = null; }
    if (slot === 'title') { p.equippedTitle = null; pr.equippedTitle = null; }
    if (slot === 'badge') { p.equippedBadge = null; pr.equippedBadge = null; }
    socket.emit('cosmeticEquipped', { cosmeticId: null, equippedTrail: p.equippedTrail, equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge });
  });

  socket.on('ownerAction', ({ action, targetId, value, password }) => {
    if (password !== OWNER_PASSWORD) { socket.emit('ownerError', 'Invalid password.'); return; }
    const target = targetId ? Object.values(players).find(p => p.id === targetId) : null;
    switch (action) {
      case 'kick':
        if (target && !target.isBot) { io.to(target.socketId).emit('kicked', { reason: value || 'Kicked.' }); killPlayer(target, null); setTimeout(() => { const s = io.sockets.sockets.get(target.socketId); if (s) s.disconnect(true); }, 500); socket.emit('ownerSuccess', `Kicked ${target.name}`); } break;
      case 'instaKill':
        if (target) { killPlayer(target, null); if (target.socketId) io.to(target.socketId).emit('systemMessage', '☠️ Eliminated by Z3N0'); socket.emit('ownerSuccess', `Killed ${target.name}`); } break;
      case 'giveSkin':
        if (target) { target.skin = value; target.grantedSkin = value; if (target.socketId) io.to(target.socketId).emit('skinGranted', { skin: value }); socket.emit('ownerSuccess', 'Gave skin'); } break;
      case 'giveSize':
        if (target) { const n = parseInt(value) || 50, tail = target.segments[target.segments.length-1]; for (let i = 0; i < n * SEG_DIST; i++) target.segments.push({ x: tail.x, y: tail.y }); target.score += n * 10; if (target.socketId) io.to(target.socketId).emit('systemMessage', `📏 +${n} size!`); socket.emit('ownerSuccess', 'Size given'); } break;
      case 'giveCoins':
        if (target && !target.isBot) { const n = parseInt(value) || 100, pr = getProfile(target.accountId || target.playfabId, target.name); pr.coins += n; if (target.socketId) { io.to(target.socketId).emit('coinsGranted', { amount: n, newBalance: pr.coins }); io.to(target.socketId).emit('systemMessage', `💰 +${n} coins!`); } socket.emit('ownerSuccess', 'Coins given'); } break;
      case 'spawnPowerUp': spawnPowerUp(); socket.emit('ownerSuccess', 'Spawned!'); break;
      case 'spawnPortals': spawnPortalPair(); socket.emit('ownerSuccess', 'Portals!'); break;
      case 'broadcast': io.emit('ownerBroadcast', { message: value }); socket.emit('ownerSuccess', 'Sent!'); break;
      case 'startEvent':
        activeEvent = { id: uuidv4(), type: value, name: eventName(value), startedAt: Date.now(), duration: 60000 };
        applyEvent(activeEvent); io.emit('liveEvent', activeEvent);
        socket.emit('ownerSuccess', `Started: ${activeEvent.name}`);
        setTimeout(() => { activeEvent = null; resetEvent(); io.emit('eventEnded'); }, 60000); break;
      case 'endEvent': activeEvent = null; resetEvent(); io.emit('eventEnded'); socket.emit('ownerSuccess', 'Ended.'); break;
      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p => !p.dead).map(p => {
          const pr = p.isBot ? { coins: 0, unlockedCosmetics: [] } : getProfile(p.accountId || p.playfabId, p.name);
          return { id: p.id, name: p.name, skin: p.skin, score: p.score, length: p.segments.length, isOwner: p.isOwner, isBot: p.isBot || false, coins: pr.coins, sessionCoins: p.sessionCoins, equippedTrail: p.equippedTrail, equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge, kills: p.kills || 0, killStreak: p.killStreak || 0 };
        })); break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p && !p.isBot) {
      if (p.sessionCoins > 0) { const pr = getProfile(p.accountId || p.playfabId, p.name); pr.coins += p.sessionCoins; }
      p.sessionCoins = 0;
      killPlayer(p, null);
      setTimeout(() => { delete players[socket.playerId]; io.emit('playerLeft', socket.playerId); }, 500);
    }
  });
});

// ============================================================
//  EVENTS
// ============================================================
function eventName(t) {
  return {
    speedBoost: '⚡ HYPERSPEED FRENZY', orbFrenzy: '🌟 ORB OVERLOAD', shrinkAll: '💀 DEATH SHRINK',
    growAll: '🐍 TITAN RISE', powerUpRain: '🎁 POWER-UP RAIN', goldRush: '⭐ GOLD RUSH',
    megaOrbs: '💎 MEGA ORB MADNESS', berserk: '🔥 BERSERK MODE',
  }[t] || t;
}

function applyEvent(ev) {
  if (ev.type === 'speedBoost') for (const p of Object.values(players)) p.speed = SNAKE_SPEED * 2;
  if (ev.type === 'orbFrenzy') { for (let i = 0; i < 500; i++) { const o = mkOrb(); orbs[o.id] = o; } io.emit('orbFrenzy', Object.values(orbs)); }
  if (ev.type === 'shrinkAll') for (const p of Object.values(players)) if (!p.isOwner) p.segments = p.segments.slice(0, Math.max(INIT_LEN * SEG_DIST, p.segments.length >> 1));
  if (ev.type === 'growAll') for (const p of Object.values(players)) { const t = p.segments[p.segments.length-1]; for (let i = 0; i < 60 * SEG_DIST; i++) p.segments.push({ x: t.x, y: t.y }); }
  if (ev.type === 'powerUpRain') { for (let i = 0; i < 25; i++) spawnPowerUp(); }
  if (ev.type === 'goldRush') { for (let i = 0; i < 40; i++) { const o = mkOrb(undefined, undefined, true); orbs[o.id] = o; } io.emit('orbFrenzy', Object.values(orbs)); }
  if (ev.type === 'megaOrbs') { for (let i = 0; i < 20; i++) { const o = mkOrb(undefined, undefined, false, true); orbs[o.id] = o; } io.emit('orbFrenzy', Object.values(orbs)); }
  if (ev.type === 'berserk') {
    const now = Date.now();
    for (const p of Object.values(players)) {
      if (!p.activePowerUps) p.activePowerUps = {};
      p.activePowerUps.rage = { start: now, end: now + ev.duration, until: now + ev.duration };
      p.speed = SNAKE_SPEED * 2;
    }
    io.emit('systemMessage', '🔥 BERSERK MODE! Everyone moves at double speed!');
  }
}

function resetEvent() { for (const p of Object.values(players)) p.speed = SNAKE_SPEED; }

setInterval(() => {
  if (activeEvent) return;
  if (Object.values(players).filter(p => !p.isBot && !p.dead).length < 1) return;
  const types = ['orbFrenzy', 'powerUpRain', 'goldRush', 'speedBoost', 'megaOrbs'];
  const type = types[Math.random() * types.length | 0];
  activeEvent = { id: uuidv4(), type, name: eventName(type), startedAt: Date.now(), duration: 45000 };
  applyEvent(activeEvent);
  io.emit('liveEvent', activeEvent);
  setTimeout(() => { activeEvent = null; resetEvent(); io.emit('eventEnded'); }, 45000);
}, 120000 + Math.random() * 120000);

// ============================================================
//  HTTP API
// ============================================================
app.get('/api/leaderboard', (_, res) => res.json(leaderboard));
app.get('/api/stats', (_, res) => res.json({
  players: Object.values(players).filter(p => !p.isBot && !p.dead).length,
  bots: Object.values(players).filter(p => p.isBot && !p.dead).length,
  orbs: Object.keys(orbs).length,
  powerUps: Object.keys(powerUps).length,
  portals: Object.keys(portals).length,
  activeEvent: activeEvent?.name || null,
  globalKillCount,
  topKiller: dailyTopKiller,
}));

const adminAuth = (req, res, next) => req.headers['x-admin-password'] === ADMIN_PASS ? next() : res.status(401).json({ error: 'Unauthorized' });
app.post('/api/admin/auth', (req, res) => res.json({ success: req.body.password === ADMIN_PASS }));
app.get('/api/admin/players', adminAuth, (_, res) => {
  const live = {};
  Object.values(players).filter(p => !p.isBot).forEach(p => { live[p.accountId || p.playfabId || ('guest:' + p.name.toLowerCase())] = p; });
  res.json(Object.values(playerDB).map(pr => { const p = live[pr.id]; return { name: pr.name, online: !!p, coins: pr.coins + (p ? p.sessionCoins : 0), totalScore: pr.totalScore + (p ? p.score : 0), totalKills: pr.totalKills + (p ? p.kills || 0 : 0), gamesPlayed: pr.gamesPlayed, highScore: pr.highScore, unlockedCosmetics: pr.unlockedCosmetics, currentSize: p ? p.segments.length : 0, currentSkin: p ? p.skin : null, firstSeen: pr.firstSeen, lastSeen: pr.lastSeen }; }));
});
app.post('/api/admin/giveCoins', adminAuth, (req, res) => {
  const { name, amount } = req.body;
  const pr = Object.values(playerDB).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.coins += parseInt(amount) || 0;
  const lp = Object.values(players).find(p => !p.isBot && p.name.toLowerCase() === name.toLowerCase());
  if (lp?.socketId) io.to(lp.socketId).emit('coinsGranted', { amount, newBalance: pr.coins });
  res.json({ success: true, newBalance: pr.coins });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Snake Realm ULTRA — port ${PORT}`);
  console.log(`👑 Owner: ${OWNER_PASSWORD}  🔐 Admin: ${ADMIN_PASS}`);
  console.log(`🤖 ${BOT_COUNT} bots | Map: ${MAP_SIZE}x${MAP_SIZE} | 🌟 ${ORB_COUNT} orbs | 🛡️ Spawn grace: ${NEW_PLAYER_GRACE}ms`);
  console.log(`🔥 New: Rage PU | ✂️ Shrink PU | 💎 Mega Orbs | 🔥 Berserk Event`);
});
