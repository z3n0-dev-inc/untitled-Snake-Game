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
const MAP_SIZE        = 6000;
const ORB_COUNT       = 600;
const TICK_MS         = 33;
const BROADCAST_MS    = 45;
const SNAKE_SPEED     = 3.2;
const BOOST_SPEED     = 5.8;
const SEG_DIST        = 12;
const INIT_LEN        = 10;
const GROW_PER_ORB    = 3;
const BOT_COUNT       = 10;
const VIEW_RADIUS_SQ  = 1600 * 1600;
const MAX_PLAYERS     = 50;

const OWNER_SKINS = new Set([
  'rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine',
  'z3n0_exclusive','death_god','cosmos','blood_moon','electric_god'
]);

// ============================================================
//  ACCOUNT DB (in-memory, persists as long as server runs)
//  In production, replace with a real database
// ============================================================
const accountDB = {}; // key: username.toLowerCase() -> account
const playerDB  = {}; // key: accountId or playfabId -> profile

// Simple crypto for password hashing (use bcrypt in production)
const crypto = require('crypto');
function hashPass(password) {
  return crypto.createHash('sha256').update(password + 'z3n0salt_ULTRA_2024').digest('hex');
}
function genAccountId() { return 'acc_' + uuidv4(); }

// ============================================================
//  ACCOUNT ENDPOINTS
// ============================================================

// Register new account
app.post('/api/account/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'Username, password, and display name required.' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3–20 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (displayName.length < 2 || displayName.length > 20) {
    return res.status(400).json({ error: 'Display name must be 2–20 characters.' });
  }
  const key = username.toLowerCase().trim();
  if (accountDB[key]) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  const accountId = genAccountId();
  const now = Date.now();
  accountDB[key] = {
    accountId,
    username: username.trim(),
    displayName: displayName.trim(),
    passwordHash: hashPass(password),
    createdAt: now,
    lastLogin: now,
  };
  playerDB[accountId] = {
    id: accountId,
    name: displayName.trim(),
    coins: 500,
    totalScore: 0, totalKills: 0,
    gamesPlayed: 0, highScore: 0,
    unlockedCosmetics: ['title_rookie'],
    equippedTrail: null, equippedTitle: null, equippedBadge: null,
    firstSeen: now, lastSeen: now,
  };
  res.json({
    success: true,
    accountId,
    displayName: displayName.trim(),
    token: hashPass(accountId + password), // simple session token
    profile: getProfileById(accountId),
  });
});

// Login
app.post('/api/account/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }
  const key = username.toLowerCase().trim();
  const acc = accountDB[key];
  if (!acc) return res.status(401).json({ error: 'Account not found.' });
  if (acc.passwordHash !== hashPass(password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  acc.lastLogin = Date.now();
  const pr = getProfileById(acc.accountId);
  pr.lastSeen = Date.now();
  res.json({
    success: true,
    accountId: acc.accountId,
    displayName: acc.displayName,
    token: hashPass(acc.accountId + password),
    profile: pr,
  });
});

// Get profile
app.get('/api/account/profile/:accountId', (req, res) => {
  const pr = playerDB[req.params.accountId];
  if (!pr) return res.status(404).json({ error: 'Profile not found.' });
  res.json(pr);
});

function getProfileById(accountId) {
  if (!playerDB[accountId]) {
    playerDB[accountId] = {
      id: accountId,
      name: 'Snake',
      coins: 500,
      totalScore: 0, totalKills: 0,
      gamesPlayed: 0, highScore: 0,
      unlockedCosmetics: ['title_rookie'],
      equippedTrail: null, equippedTitle: null, equippedBadge: null,
      firstSeen: Date.now(), lastSeen: Date.now(),
    };
  }
  return playerDB[accountId];
}

function getProfile(accountId, name) {
  const key = accountId || ('guest:' + (name || '').toLowerCase().trim());
  if (!playerDB[key]) {
    playerDB[key] = {
      id: key, name: name || 'Snake',
      coins: 500, totalScore: 0, totalKills: 0,
      gamesPlayed: 0, highScore: 0,
      unlockedCosmetics: ['title_rookie'],
      equippedTrail: null, equippedTitle: null, equippedBadge: null,
      firstSeen: Date.now(), lastSeen: Date.now(),
      isGuest: !accountId,
    };
  }
  const p = playerDB[key];
  p.lastSeen = Date.now();
  if (name && p.name !== name) p.name = name;
  return p;
}

// ============================================================
//  COSMETICS — built from PlayFab catalog
// ============================================================
let PLAYFAB_CATALOG = { Catalog: [] };
try { PLAYFAB_CATALOG = require('./Z3N0_PlayFab_Catalog.json'); } catch(e) { console.log('[INFO] No PlayFab catalog JSON found, using empty catalog. Clients will use fallback.'); }

const COSMETICS = {};
for (const item of PLAYFAB_CATALOG.Catalog) {
  let custom = {};
  try { custom = JSON.parse(item.CustomData || '{}'); } catch(e) {}
  const price = item.VirtualCurrencyPrices?.GC ?? 0;
  const rarity = custom.rarity || 'common';
  COSMETICS[item.ItemId] = {
    id:        item.ItemId,
    type:      custom.type || 'badge',
    name:      item.DisplayName,
    price,
    emoji:     custom.emoji || '❓',
    glow:      custom.glow || null,
    text:      custom.text || null,
    rarity,
    ownerOnly: custom.ownerOnly === true,
    tags:      item.Tags || [],
  };
}

// Always include free starter title
if (!COSMETICS['title_rookie']) {
  COSMETICS['title_rookie'] = { id:'title_rookie', type:'title', name:'🐍 [ROOKIE]', price:0, emoji:'🐍', text:'[ROOKIE]', rarity:'common', ownerOnly:false };
}

// Build a quick lookup for trail glow colors (used by renderer)
const TRAIL_GLOW_MAP = {};
for (const [id, c] of Object.entries(COSMETICS)) {
  if (c.type === 'trail' && c.glow) TRAIL_GLOW_MAP[id] = c.glow;
}

// ============================================================
//  GAME STATE
// ============================================================
let players     = {};
let orbs        = {};
let powerUps    = {};
let portals     = {};
let activeEvent = null;
let leaderboard = [];
let serverKillFeed = [];
let globalKillCount = 0;

// ============================================================
//  ORBS
// ============================================================
const ORB_COLORS = [
  '#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff',
  '#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff',
  '#00ff88','#ff3366','#66ffcc','#ffaa00','#aa00ff'
];

function mkOrb(x, y, golden) {
  const isGolden = golden || Math.random() < 0.01;
  return {
    id: uuidv4(),
    x: x !== undefined ? x : Math.random() * MAP_SIZE,
    y: y !== undefined ? y : Math.random() * MAP_SIZE,
    color: isGolden ? '#ffdd00' : ORB_COLORS[Math.random() * ORB_COLORS.length | 0],
    size: isGolden ? 12 : Math.random() * 6 + 4,
    value: isGolden ? 8 : (Math.random() * 3 | 0) + 1,
    golden: isGolden,
  };
}

for (let i = 0; i < ORB_COUNT; i++) { const o = mkOrb(); orbs[o.id] = o; }
for (let i = 0; i < 8; i++) { const o = mkOrb(undefined, undefined, true); orbs[o.id] = o; }

function mkSegs(x, y, len) {
  const a = [];
  for (let i = 0; i < len; i++) a.push({ x: x - i * SEG_DIST, y });
  return a;
}

function dsq(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

// ============================================================
//  POWER-UPS
// ============================================================
const PU_TYPES = ['speed', 'shield', 'ghost', 'magnet', 'bomb', 'freeze', 'grow', 'star'];
const PU_CONFIG = {
  speed:  { duration: 6000,  color: '#ffcc00', emoji: '⚡' },
  shield: { duration: 10000, color: '#00aaff', emoji: '🛡️' },
  ghost:  { duration: 5000,  color: '#94a3b8', emoji: '👻' },
  magnet: { duration: 8000,  color: '#c084fc', emoji: '🧲' },
  bomb:   { duration: 0,     color: '#ff4400', emoji: '💥' },
  freeze: { duration: 4000,  color: '#06b6d4', emoji: '🌀' },
  grow:   { duration: 0,     color: '#00ff88', emoji: '🍄' },
  star:   { duration: 7000,  color: '#fbbf24', emoji: '⭐' },
};

function spawnPowerUp() {
  const id = uuidv4();
  const type = PU_TYPES[Math.random() * PU_TYPES.length | 0];
  powerUps[id] = {
    id, type,
    x: 400 + Math.random() * (MAP_SIZE - 800),
    y: 400 + Math.random() * (MAP_SIZE - 800),
    spawnedAt: Date.now(),
  };
  io.emit('powerUpSpawned', powerUps[id]);
}

for (let i = 0; i < 10; i++) spawnPowerUp();

// ============================================================
//  PORTALS
// ============================================================
function spawnPortalPair() {
  const id1 = uuidv4(), id2 = uuidv4();
  const margin = 600;
  const p1 = { id: id1, linkedId: id2, x: margin + Math.random() * (MAP_SIZE - margin * 2), y: margin + Math.random() * (MAP_SIZE - margin * 2), color: '#a855f7', cooldowns: {} };
  const p2 = { id: id2, linkedId: id1, x: margin + Math.random() * (MAP_SIZE - margin * 2), y: margin + Math.random() * (MAP_SIZE - margin * 2), color: '#a855f7', cooldowns: {} };
  while (dsq(p1, p2) < 1200 * 1200) {
    p2.x = margin + Math.random() * (MAP_SIZE - margin * 2);
    p2.y = margin + Math.random() * (MAP_SIZE - margin * 2);
  }
  portals[id1] = p1; portals[id2] = p2;
  io.emit('portalsSpawned', [p1, p2]);
  setTimeout(() => {
    delete portals[id1]; delete portals[id2];
    io.emit('portalsRemoved', [id1, id2]);
    setTimeout(spawnPortalPair, 15000 + Math.random() * 20000);
  }, 45000);
}

setTimeout(spawnPortalPair, 20000);

// ============================================================
//  AI BOTS
// ============================================================
const BOT_NAMES  = ['Slinky','Viper','NightCrawler','Zapper','Coil','Fang','Serpentine','Nexus','Mamba','Taipan'];
const BOT_SKINS  = ['fire','ice','toxic','gold','midnight','sunset','ocean','lava','electric','forest'];
const BOT_TAUNTS = [
  'get rekt', 'too slow', 'catch me if you can', 'gg no re',
  'skill issue', 'L + ratio', 'you\'re food', 'not even close'
];

function mkBot(i) {
  const x = Math.random() * (MAP_SIZE - 600) + 300;
  const y = Math.random() * (MAP_SIZE - 600) + 300;
  return {
    id: 'bot_' + uuidv4(), socketId: null, isBot: true,
    name: BOT_NAMES[i % BOT_NAMES.length],
    skin: BOT_SKINS[i % BOT_SKINS.length],
    grantedSkin: null, playfabId: null, accountId: null,
    segments: mkSegs(x, y, INIT_LEN * 5),
    angle: Math.random() * Math.PI * 2,
    speed: SNAKE_SPEED, boosting: false,
    growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
    width: 8, dead: false, alive: true,
    isOwner: false, effect: null,
    equippedTrail: null, equippedTitle: '[BOT]', equippedBadge: '🤖',
    unlockedCosmetics: [],
    activePowerUps: {},
    ghostUntil: 0, shieldActive: false,
    killStreak: 0,
    _turnTimer: 0, _boostTimer: 0, _wanderAngle: Math.random() * Math.PI * 2,
    _tauntTimer: 200 + Math.random() * 300 | 0,
    _aggressionLevel: 0.3 + Math.random() * 0.5,
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
  bot._turnTimer--;
  bot._boostTimer--;
  bot._tauntTimer--;

  const M = 400;
  if (h.x < M)             bot.angle = lerpAngle(bot.angle, 0, 0.3);
  else if (h.x > MAP_SIZE - M) bot.angle = lerpAngle(bot.angle, Math.PI, 0.3);
  if (h.y < M)             bot.angle = lerpAngle(bot.angle, Math.PI / 2, 0.3);
  else if (h.y > MAP_SIZE - M) bot.angle = lerpAngle(bot.angle, -Math.PI / 2, 0.3);

  let nearPU = null, nearPUD = 350 * 350;
  for (const pid in powerUps) {
    const pu = powerUps[pid];
    const d = dsq(h, pu);
    if (d < nearPUD) { nearPUD = d; nearPU = pu; }
  }

  let huntTarget = null, huntD = 500 * 500;
  const arr = Object.values(players);
  for (const other of arr) {
    if (other.id === bot.id || other.dead || !other.segments.length) continue;
    const d = dsq(h, other.segments[0]);
    if (d < huntD && other.segments.length < bot.segments.length * 0.9) {
      huntD = d; huntTarget = other;
    }
  }

  let evadeTarget = null;
  for (const other of arr) {
    if (other.id === bot.id || other.dead || !other.segments.length) continue;
    const d = dsq(h, other.segments[0]);
    if (d < 200 * 200 && other.segments.length > bot.segments.length * 1.1) {
      evadeTarget = other; break;
    }
  }

  if (evadeTarget) {
    bot.angle = lerpAngle(bot.angle,
      Math.atan2(h.y - evadeTarget.segments[0].y, h.x - evadeTarget.segments[0].x), 0.25);
    bot.boosting = bot._boostTimer > 0 && bot.segments.length > INIT_LEN * 3;
  } else if (nearPU && Math.random() < 0.4) {
    bot.angle = lerpAngle(bot.angle, Math.atan2(nearPU.y - h.y, nearPU.x - h.x), 0.15);
    bot.boosting = nearPUD < 150 * 150;
  } else if (huntTarget && Math.random() < bot._aggressionLevel) {
    bot.angle = lerpAngle(bot.angle,
      Math.atan2(huntTarget.segments[0].y - h.y, huntTarget.segments[0].x - h.x), 0.18);
    bot.boosting = huntD < 250 * 250 && bot._boostTimer > 0 && bot.segments.length > INIT_LEN * 4;
  } else {
    let nearOrb = null, nearD = 600 * 600;
    for (const oid in orbs) {
      const o = orbs[oid];
      const d = dsq(h, o);
      if (d < nearD) { nearD = d; nearOrb = o; }
    }
    if (nearOrb) {
      bot.angle = lerpAngle(bot.angle, Math.atan2(nearOrb.y - h.y, nearOrb.x - h.x), 0.12);
    } else {
      if (bot._turnTimer <= 0) {
        bot._wanderAngle += (Math.random() - 0.5) * 1.4;
        bot._turnTimer = 40 + Math.random() * 80 | 0;
      }
      bot.angle = lerpAngle(bot.angle, bot._wanderAngle, 0.08);
    }
    if (bot._boostTimer <= 0) {
      bot.boosting = Math.random() < 0.1;
      bot._boostTimer = 30 + Math.random() * 60 | 0;
    }
  }

  if (bot._tauntTimer <= 0 && bot.kills > 0 && Math.random() < 0.3) {
    const taunt = BOT_TAUNTS[Math.random() * BOT_TAUNTS.length | 0];
    io.emit('botTaunt', { botId: bot.id, name: bot.name, message: taunt });
    bot._tauntTimer = 400 + Math.random() * 600 | 0;
  }
}

function respawnBot(bot) {
  const x = Math.random() * (MAP_SIZE - 600) + 300;
  const y = Math.random() * (MAP_SIZE - 600) + 300;
  bot.segments = mkSegs(x, y, INIT_LEN * 5);
  bot.angle = Math.random() * Math.PI * 2;
  bot.dead = false; bot.alive = true;
  bot.score = 0; bot.sessionCoins = 0;
  bot.growBuffer = 0; bot.width = 8; bot.boosting = false;
  bot.activePowerUps = {}; bot.ghostUntil = 0; bot.shieldActive = false;
  bot.killStreak = 0;
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

  const dropN = Math.min(Math.floor(player.segments.length / 3), 80);
  const dropped = [];
  for (let i = 0; i < dropN; i++) {
    const seg = player.segments[Math.random() * player.segments.length | 0];
    const o = mkOrb(
      seg.x + (Math.random() - 0.5) * 60,
      seg.y + (Math.random() - 0.5) * 60
    );
    o.size = 8; o.value = 2;
    orbs[o.id] = o;
    dropped.push(o);
  }

  io.emit('playerDied', {
    id: player.id,
    killerName: killer ? killer.name : 'the wall',
    droppedOrbs: dropped,
    position: player.segments[0],
    length: player.segments.length,
  });

  if (killer) {
    killer.score += Math.floor(player.score * 0.3) + player.segments.length;
    killer.sessionCoins += Math.floor(player.score * 0.15) + 10;
    killer.kills = (killer.kills || 0) + 1;
    killer.killStreak = (killer.killStreak || 0) + 1;

    if (!killer.isBot) {
      const pr = getProfile(killer.accountId || killer.playfabId, killer.name);
      pr.totalKills++;
      if (killer.killStreak >= 3) {
        io.to(killer.socketId).emit('killStreakBonus', {
          streak: killer.killStreak,
          bonusCoins: killer.killStreak * 10,
        });
        killer.sessionCoins += killer.killStreak * 10;
        pr.coins += killer.killStreak * 10;
      }
    }
    if (killer.socketId) {
      io.to(killer.socketId).emit('killConfirmed', {
        victimName: player.name,
        coinsGained: Math.floor(player.score * 0.15) + 10,
        streak: killer.killStreak,
      });
    }

    const kfEntry = {
      id: uuidv4(),
      killer: killer.name,
      victim: player.name,
      killerId: killer.id,
      victimId: player.id,
      isBot: killer.isBot,
      ts: Date.now(),
    };
    serverKillFeed.unshift(kfEntry);
    serverKillFeed = serverKillFeed.slice(0, 8);
    io.emit('killFeedUpdate', kfEntry);
  }

  if (!player.isBot && player.socketId) {
    io.to(player.socketId).emit('youDied', {
      killerName: killer ? killer.name : 'the wall',
      coinsEarned: player.sessionCoins,
      score: player.score,
      length: player.segments.length,
    });
    // Save coins back to profile on death
    const pr = getProfile(player.accountId || player.playfabId, player.name);
    pr.coins += player.sessionCoins;
    setTimeout(() => { delete players[player.id]; io.emit('playerLeft', player.id); }, 1000);
  } else if (player.isBot) {
    setTimeout(() => respawnBot(player), 2000 + Math.random() * 3000);
  }
}

// ============================================================
//  POWER-UP PICKUP
// ============================================================
function checkPowerUpPickup(p) {
  const h = p.segments[0];
  for (const pid in powerUps) {
    const pu = powerUps[pid];
    if (dsq(h, pu) < 40 * 40) {
      applyPowerUp(p, pu);
      delete powerUps[pid];
      io.emit('powerUpCollected', { puId: pid, playerId: p.id, type: pu.type });
      setTimeout(spawnPowerUp, 8000 + Math.random() * 12000);
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
      const arr = Object.values(players);
      for (const other of arr) {
        if (other.id === p.id || other.dead || !other.segments.length) continue;
        if (dsq(p.segments[0], other.segments[0]) < 320 * 320) {
          if (!p.isBot) killPlayer(other, p);
          killed++;
        }
      }
      io.emit('bombExploded', { x: p.segments[0].x, y: p.segments[0].y, playerId: p.id, killed });
      break;
    }
    case 'grow':
      for (let i = 0; i < 80 * SEG_DIST; i++) {
        const tail = p.segments[p.segments.length - 1];
        p.segments.push({ x: tail.x, y: tail.y });
      }
      p.score += 50;
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
      p.speed = SNAKE_SPEED * 1.3;
      break;
    case 'speed':
      p.activePowerUps.speed = { start: now, end: now + cfg.duration, until: now + cfg.duration };
      p.speed = SNAKE_SPEED * 1.8;
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

  if (cfg.duration > 0 && pu.type !== 'star' && pu.type !== 'speed' && pu.type !== 'shield') {
    setTimeout(() => { if (p.activePowerUps) delete p.activePowerUps[pu.type]; }, cfg.duration);
  }
  if ((pu.type === 'star' || pu.type === 'speed') && cfg.duration > 0) {
    setTimeout(() => {
      if (!p.dead) p.speed = SNAKE_SPEED;
      if (p.activePowerUps) delete p.activePowerUps[pu.type];
    }, cfg.duration);
  }

  if (!p.isBot && p.socketId) {
    io.to(p.socketId).emit('powerUpActivated', {
      type: pu.type,
      duration: cfg.duration,
      emoji: cfg.emoji,
    });
  }
}

// ============================================================
//  PORTAL TELEPORT
// ============================================================
function checkPortals(p) {
  const h = p.segments[0];
  for (const pid in portals) {
    const portal = portals[pid];
    if (portal.cooldowns[p.id] && Date.now() < portal.cooldowns[p.id]) continue;
    if (dsq(h, portal) < 45 * 45) {
      const dest = portals[portal.linkedId];
      if (!dest) continue;
      const offset = 60;
      const newX = dest.x + Math.cos(p.angle) * offset;
      const newY = dest.y + Math.sin(p.angle) * offset;
      const shiftX = newX - h.x, shiftY = newY - h.y;
      p.segments = p.segments.map(s => ({ x: s.x + shiftX, y: s.y + shiftY }));
      portal.cooldowns[p.id] = Date.now() + 2000;
      dest.cooldowns[p.id] = Date.now() + 2000;
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('teleported', { from: pid, to: portal.linkedId });
      }
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
    const o = orbs[oid];
    const d2 = dsq(h, o);
    if (d2 < 280 * 280 && d2 > 1) {
      const d = Math.sqrt(d2);
      const pull = Math.min(400 / d, 4);
      o.x += (h.x - o.x) / d * pull;
      o.y += (h.y - o.y) / d * pull;
    }
  }
}

// ============================================================
//  COLLISION
// ============================================================
function checkCollisions() {
  const arr = Object.values(players);
  for (const p of arr) {
    if (p.dead) continue;
    const h = p.segments[0];
    const isGhost = p.ghostUntil && Date.now() < p.ghostUntil;

    if (h.x < -10 || h.x > MAP_SIZE + 10 || h.y < -10 || h.y > MAP_SIZE + 10) {
      killPlayer(p, null); continue;
    }

    if (p.activePowerUps?.frozen && Date.now() > p.activePowerUps.frozen.until) {
      delete p.activePowerUps.frozen;
      p.speed = SNAKE_SPEED;
    }

    for (const oid in orbs) {
      const o = orbs[oid];
      const r = p.width + o.size;
      if (dsq(h, o) < r * r) {
        p.growBuffer += GROW_PER_ORB * o.value;
        p.score += o.value;
        p.sessionCoins += Math.ceil(o.value / 3);
        delete orbs[oid];
        const neo = mkOrb();
        orbs[neo.id] = neo;
        io.emit('orbEaten', { oid, newOrb: neo, eaterId: p.id });
        break;
      }
    }
    if (p.dead) continue;

    checkPowerUpPickup(p);
    checkPortals(p);
    applyMagnet(p);

    if (isGhost) continue;

    for (const other of arr) {
      if (other.id === p.id || other.dead) continue;
      const otherGhost = other.ghostUntil && Date.now() < other.ghostUntil;
      const segs = other.segments;

      for (let si = 3; si < segs.length; si += (si < 20 ? 1 : 2)) {
        const r = p.width + other.width - 4;
        if (dsq(h, segs[si]) < r * r) {
          if (p.shieldActive) {
            p.shieldActive = false;
            if (p.activePowerUps) delete p.activePowerUps.shield;
            if (p.socketId) io.to(p.socketId).emit('shieldPopped', {});
            break;
          }
          if (!otherGhost) { killPlayer(p, other); break; }
        }
      }
      if (p.dead) break;

      if (p.segments.length <= other.segments.length) {
        const r = p.width + other.width;
        if (dsq(h, segs[0]) < r * r) {
          if (p.shieldActive) {
            p.shieldActive = false;
            if (p.activePowerUps) delete p.activePowerUps.shield;
            if (p.socketId) io.to(p.socketId).emit('shieldPopped', {});
          } else if (!otherGhost) {
            killPlayer(p, other); break;
          }
        }
      }
    }
  }
}

// ============================================================
//  GAME TICK
// ============================================================
function gameTick() {
  for (const pid in players) {
    const p = players[pid];
    if (p.dead || !p.alive) continue;
    if (p.isBot) tickBot(p);

    const frozen = p.activePowerUps?.frozen && Date.now() < p.activePowerUps.frozen.until;
    const spd = frozen ? (SNAKE_SPEED * 0.35) : (p.boosting ? BOOST_SPEED : (p.speed || SNAKE_SPEED));
    const h = p.segments[0];
    p.segments.unshift({ x: h.x + Math.cos(p.angle) * spd, y: h.y + Math.sin(p.angle) * spd });

    if (p.growBuffer > 0) p.growBuffer--;
    else p.segments.pop();

    p.width = Math.max(6, Math.min(26, 6 + p.segments.length * 0.025));

    if (p.boosting && p.segments.length > INIT_LEN * SEG_DIST && Math.random() < 0.25) {
      const tail = p.segments[p.segments.length - 1];
      const o = mkOrb(tail.x, tail.y);
      o.size = 7; o.value = 1;
      orbs[o.id] = o;
      p.segments.pop();
    }
  }
  checkCollisions();

  leaderboard = Object.values(players)
    .filter(p => !p.dead)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map((p, i) => ({
      rank: i + 1,
      id: p.id, name: p.name,
      length: p.segments.length,
      score: p.score,
      skin: p.skin,
      isOwner: p.isOwner,
      isBot: p.isBot || false,
      equippedTitle: p.equippedTitle,
      equippedBadge: p.equippedBadge,
      killStreak: p.killStreak || 0,
    }));
}

setInterval(gameTick, TICK_MS);

// ============================================================
//  STATE BROADCAST
// ============================================================
function buildState(p) {
  let segs = p.segments;
  if (segs.length > 120) segs = segs.filter((_, i) => i < 25 || i % 2 === 0);
  return {
    segments: segs, angle: p.angle,
    skin: p.skin, grantedSkin: p.grantedSkin || null,
    name: p.name, width: p.width, boosting: p.boosting,
    isOwner: p.isOwner, isBot: p.isBot || false,
    equippedTrail: p.equippedTrail || null,
    equippedTitle: p.equippedTitle || null,
    equippedBadge: p.equippedBadge || null,
    activePowerUps: p.activePowerUps || {},
    ghostUntil: p.ghostUntil || 0,
    shieldActive: p.shieldActive || false,
    killStreak: p.killStreak || 0,
    score: p.score,
  };
}

setInterval(() => {
  const alive = Object.values(players).filter(p => !p.dead);
  for (const pid in players) {
    const me = players[pid];
    if (me.isBot || !me.socketId || me.dead) continue;
    const mh = me.segments[0];
    if (!mh) continue;
    const state = {};
    state[me.id] = buildState(me);
    for (const p of alive) {
      if (p.id === me.id) continue;
      if (dsq(mh, p.segments[0]) <= VIEW_RADIUS_SQ)
        state[p.id] = buildState(p);
    }
    io.to(me.socketId).emit('gameState', {
      players: state,
      leaderboard,
      activeEvent,
      powerUps: Object.values(powerUps),
      portals: Object.values(portals),
      myCoins: me.sessionCoins,
    });
  }
}, BROADCAST_MS);

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', socket => {

  socket.on('joinGame', ({ name, skin, password, playfabId, accountId }) => {
    const humanCount = Object.values(players).filter(p => !p.isBot && !p.dead).length;
    if (humanCount >= MAX_PLAYERS) {
      socket.emit('serverFull', { message: 'Server is full! Try again soon.' });
      return;
    }

    const isOwner = password === OWNER_PASSWORD;
    const safeSkin = isOwner ? skin : (OWNER_SKINS.has(skin) ? 'classic' : skin);
    const x = Math.random() * (MAP_SIZE - 600) + 300;
    const y = Math.random() * (MAP_SIZE - 600) + 300;

    // Resolve profile: prefer accountId, then playfabId, then name-based
    const profileKey = accountId || playfabId || null;
    const pr = getProfile(profileKey, name);

    const player = {
      id: uuidv4(), socketId: socket.id, isBot: false,
      name: pr.name || name || 'Snake',
      skin: safeSkin, grantedSkin: null,
      playfabId: playfabId || null,
      accountId: accountId || null,
      segments: mkSegs(x, y, INIT_LEN),
      angle: 0, speed: SNAKE_SPEED, boosting: false,
      growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
      width: 8, dead: false, alive: true, isOwner, effect: null,
      equippedTrail: pr.equippedTrail,
      equippedTitle: isOwner ? '[Z3N0]' : pr.equippedTitle,
      equippedBadge: isOwner ? '👑' : pr.equippedBadge,
      unlockedCosmetics: isOwner ? Object.keys(COSMETICS) : [...(pr.unlockedCosmetics || ['title_rookie'])],
      activePowerUps: {},
      ghostUntil: 0, shieldActive: false,
      killStreak: 0,
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined', {
      playerId: player.id, isOwner, mapSize: MAP_SIZE,
      orbs: Object.values(orbs),
      powerUps: Object.values(powerUps),
      portals: Object.values(portals),
      killFeed: serverKillFeed,
      profile: {
        coins: pr.coins, totalScore: pr.totalScore, totalKills: pr.totalKills,
        gamesPlayed: pr.gamesPlayed, highScore: pr.highScore,
        unlockedCosmetics: player.unlockedCosmetics,
        equippedTrail: player.equippedTrail,
        equippedTitle: player.equippedTitle,
        equippedBadge: player.equippedBadge,
        isGuest: !accountId && !playfabId,
      },
      cosmeticsCatalog: COSMETICS,
    });

    io.emit('playerJoined', { id: player.id, name: player.name, isOwner });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.playerId];
    if (!p || p.dead) return;
    p.angle = angle;
    p.boosting = !!boosting;
  });

  socket.on('buyCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId]; if (!p) return;
    const c = COSMETICS[cosmeticId];
    if (!c) { socket.emit('cosmeticError', 'Item not found.'); return; }
    if (c.ownerOnly) { socket.emit('cosmeticError', 'Owner-only item!'); return; }
    const pr = getProfile(p.accountId || p.playfabId, p.name);
    if (pr.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError', 'Already owned!'); return; }
    if (c.price > 0) {
      const totalCoins = pr.coins + p.sessionCoins;
      if (totalCoins < c.price) { socket.emit('cosmeticError', `Need ${c.price} coins (you have ${totalCoins})`); return; }
      let remaining = c.price;
      if (p.sessionCoins >= remaining) { p.sessionCoins -= remaining; }
      else { remaining -= p.sessionCoins; p.sessionCoins = 0; pr.coins -= remaining; }
    }
    pr.unlockedCosmetics.push(cosmeticId);
    p.unlockedCosmetics.push(cosmeticId);
    socket.emit('cosmeticBought', { cosmeticId, newCoinBalance: pr.coins + p.sessionCoins, unlockedCosmetics: pr.unlockedCosmetics });
  });

  socket.on('equipCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId]; if (!p) return;
    const c = COSMETICS[cosmeticId]; if (!c) return;
    if (c.ownerOnly && !p.isOwner) { socket.emit('cosmeticError', 'Owner-only item!'); return; }
    if (!p.isOwner && !p.unlockedCosmetics.includes(cosmeticId) && c.price > 0) { socket.emit('cosmeticError', "You don't own this!"); return; }
    const pr = getProfile(p.accountId || p.playfabId, p.name);
    if (c.type === 'trail') {
      p.equippedTrail = cosmeticId; pr.equippedTrail = cosmeticId;
    } else if (c.type === 'title') {
      const txt = c.text || c.name;
      p.equippedTitle = txt; pr.equippedTitle = txt;
    } else if (c.type === 'badge') {
      p.equippedBadge = c.emoji; pr.equippedBadge = c.emoji;
    }
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
        if (target && !target.isBot) {
          io.to(target.socketId).emit('kicked', { reason: value || 'Kicked by owner.' });
          killPlayer(target, null);
          setTimeout(() => { const s = io.sockets.sockets.get(target.socketId); if (s) s.disconnect(true); }, 500);
          socket.emit('ownerSuccess', `Kicked ${target.name}`);
        } break;
      case 'instaKill':
        if (target) { killPlayer(target, null); if (target.socketId) io.to(target.socketId).emit('systemMessage', '☠️ Eliminated by Z3N0'); socket.emit('ownerSuccess', `Killed ${target.name}`); } break;
      case 'giveSkin':
        if (target) { target.skin = value; target.grantedSkin = value; if (target.socketId) io.to(target.socketId).emit('skinGranted', { skin: value }); socket.emit('ownerSuccess', `Gave skin to ${target.name}`); } break;
      case 'giveSize':
        if (target) {
          const n = parseInt(value) || 50, tail = target.segments[target.segments.length - 1];
          for (let i = 0; i < n * SEG_DIST; i++) target.segments.push({ x: tail.x, y: tail.y });
          target.score += n * 10;
          if (target.socketId) io.to(target.socketId).emit('systemMessage', `📏 Z3N0 granted you +${n} size!`);
          socket.emit('ownerSuccess', `Gave ${n} size to ${target.name}`);
        } break;
      case 'giveCoins':
        if (target && !target.isBot) {
          const n = parseInt(value) || 100, pr = getProfile(target.accountId || target.playfabId, target.name);
          pr.coins += n;
          if (target.socketId) { io.to(target.socketId).emit('coinsGranted', { amount: n, newBalance: pr.coins }); io.to(target.socketId).emit('systemMessage', `💰 Z3N0 gave you +${n} coins!`); }
          socket.emit('ownerSuccess', `Gave ${n} coins to ${target.name}`);
        } break;
      case 'spawnPowerUp': spawnPowerUp(); socket.emit('ownerSuccess', 'Spawned a power-up!'); break;
      case 'spawnPortals': spawnPortalPair(); socket.emit('ownerSuccess', 'Spawned portal pair!'); break;
      case 'broadcast': io.emit('ownerBroadcast', { message: value }); socket.emit('ownerSuccess', 'Broadcast sent!'); break;
      case 'startEvent':
        activeEvent = { id: uuidv4(), type: value, name: eventName(value), startedAt: Date.now(), duration: 60000 };
        applyEvent(activeEvent); io.emit('liveEvent', activeEvent);
        socket.emit('ownerSuccess', `Started: ${activeEvent.name}`);
        setTimeout(() => { activeEvent = null; resetEvent(); io.emit('eventEnded'); }, 60000);
        break;
      case 'endEvent': activeEvent = null; resetEvent(); io.emit('eventEnded'); socket.emit('ownerSuccess', 'Event ended.'); break;
      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p => !p.dead).map(p => {
          const pr = p.isBot ? { coins: 0, unlockedCosmetics: [] } : getProfile(p.accountId || p.playfabId, p.name);
          return {
            id: p.id, name: p.name, skin: p.skin, score: p.score,
            length: p.segments.length, isOwner: p.isOwner, isBot: p.isBot || false,
            coins: pr.coins, sessionCoins: p.sessionCoins,
            unlockedCosmetics: pr.unlockedCosmetics || [],
            equippedTrail: p.equippedTrail, equippedTitle: p.equippedTitle,
            equippedBadge: p.equippedBadge, kills: p.kills || 0,
            killStreak: p.killStreak || 0,
          };
        }));
        break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p && !p.isBot) {
      // Save session coins before disconnect
      const pr = getProfile(p.accountId || p.playfabId, p.name);
      pr.coins += p.sessionCoins;
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
    speedBoost: '⚡ HYPERSPEED FRENZY',
    orbFrenzy: '🌟 ORB OVERLOAD',
    shrinkAll: '💀 DEATH SHRINK',
    growAll: '🐍 TITAN RISE',
    powerUpRain: '🎁 POWER-UP RAIN',
    goldRush: '⭐ GOLD RUSH',
  }[t] || t;
}

function applyEvent(ev) {
  if (ev.type === 'speedBoost') for (const p of Object.values(players)) p.speed = SNAKE_SPEED * 2;
  if (ev.type === 'orbFrenzy') { for (let i = 0; i < 400; i++) { const o = mkOrb(); orbs[o.id] = o; } io.emit('orbFrenzy', Object.values(orbs)); }
  if (ev.type === 'shrinkAll') for (const p of Object.values(players)) if (!p.isOwner) p.segments = p.segments.slice(0, Math.max(INIT_LEN * SEG_DIST, p.segments.length >> 1));
  if (ev.type === 'growAll') for (const p of Object.values(players)) { const t = p.segments[p.segments.length - 1]; for (let i = 0; i < 80 * SEG_DIST; i++) p.segments.push({ x: t.x, y: t.y }); }
  if (ev.type === 'powerUpRain') { for (let i = 0; i < 20; i++) spawnPowerUp(); }
  if (ev.type === 'goldRush') { for (let i = 0; i < 30; i++) { const o = mkOrb(undefined, undefined, true); orbs[o.id] = o; } io.emit('orbFrenzy', Object.values(orbs)); }
}

function resetEvent() { for (const p of Object.values(players)) p.speed = SNAKE_SPEED; }

setInterval(() => {
  if (activeEvent) return;
  const humanPlayers = Object.values(players).filter(p => !p.isBot && !p.dead).length;
  if (humanPlayers < 1) return;
  const types = ['orbFrenzy', 'powerUpRain', 'goldRush', 'speedBoost'];
  const type = types[Math.random() * types.length | 0];
  activeEvent = { id: uuidv4(), type, name: eventName(type), startedAt: Date.now(), duration: 45000 };
  applyEvent(activeEvent);
  io.emit('liveEvent', activeEvent);
  setTimeout(() => { activeEvent = null; resetEvent(); io.emit('eventEnded'); }, 45000);
}, 180000 + Math.random() * 120000);

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
}));

const adminAuth = (req, res, next) => req.headers['x-admin-password'] === ADMIN_PASS ? next() : res.status(401).json({ error: 'Unauthorized' });
app.post('/api/admin/auth', (req, res) => res.json({ success: req.body.password === ADMIN_PASS }));
app.get('/api/admin/players', adminAuth, (_, res) => {
  const live = {};
  Object.values(players).filter(p => !p.isBot).forEach(p => { live[p.accountId || p.playfabId || ('guest:' + p.name.toLowerCase())] = p; });
  res.json(Object.values(playerDB).map(pr => {
    const p = live[pr.id];
    return {
      name: pr.name, online: !!p, coins: pr.coins + (p ? p.sessionCoins : 0),
      totalScore: pr.totalScore + (p ? p.score : 0), totalKills: pr.totalKills + (p ? p.kills || 0 : 0),
      gamesPlayed: pr.gamesPlayed, highScore: pr.highScore,
      unlockedCosmetics: pr.unlockedCosmetics, currentSize: p ? p.segments.length : 0,
      currentSkin: p ? p.skin : null, firstSeen: pr.firstSeen, lastSeen: pr.lastSeen,
    };
  }));
});
app.post('/api/admin/giveCoins', adminAuth, (req, res) => {
  const { name, amount } = req.body;
  const pr = Object.values(playerDB).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.coins += parseInt(amount) || 0;
  const lp = Object.values(players).find(p => !p.isBot && p.name.toLowerCase() === name.toLowerCase());
  if (lp?.socketId) { io.to(lp.socketId).emit('coinsGranted', { amount, newBalance: pr.coins }); }
  res.json({ success: true, newBalance: pr.coins });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Snake Realm ULTRA — port ${PORT}`);
  console.log(`👑 Owner: ${OWNER_PASSWORD}  🔐 Admin: ${ADMIN_PASS}`);
  console.log(`🤖 ${BOT_COUNT} AI bots | 🎁 Power-ups active | 🌀 Portals enabled`);
  console.log(`🔑 Account system: REST API at /api/account/register & /api/account/login`);
});
