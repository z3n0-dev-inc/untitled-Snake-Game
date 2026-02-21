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
  transports: ['websocket'],  // skip long-polling for speed
});

app.use(express.static(__dirname));
app.use(express.json());

// ============================================================
//  CONFIG
// ============================================================
const OWNER_PASSWORD      = 'Z3N0ISKING';
const ADMIN_PASS          = 'Z3N0ADMIN';
const MAP_SIZE            = 6000;
const ORB_COUNT           = 500;
const TICK_MS             = 33;       // ~30 server ticks/sec
const BROADCAST_MS        = 45;       // ~22 state broadcasts/sec
const SNAKE_SPEED         = 3.0;
const BOOST_SPEED         = 5.5;
const SEG_DIST            = 12;
const INIT_LEN            = 10;
const GROW_PER_ORB        = 3;
const BOT_COUNT           = 8;
const VIEW_RADIUS_SQ      = 1500 * 1500;

const OWNER_SKINS = new Set([
  'rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine',
  'z3n0_exclusive','death_god','cosmos','blood_moon','electric_god'
]);

// ============================================================
//  PLAYER DB  (keyed by playfabId OR "name:lowercasename")
// ============================================================
const playerDB = {};

function getProfile(playfabId, name) {
  const key = playfabId || ('name:' + (name || '').toLowerCase().trim());
  if (!playerDB[key]) {
    playerDB[key] = {
      id: key, name: name || 'Snake',
      coins: 0, totalScore: 0, totalKills: 0,
      gamesPlayed: 0, highScore: 0,
      unlockedCosmetics: ['title_rookie'],
      equippedTrail: null, equippedTitle: null, equippedBadge: null,
      firstSeen: Date.now(), lastSeen: Date.now(),
      isPlayFab: !!(playfabId && !playfabId.startsWith('name:')),
    };
  }
  const p = playerDB[key];
  p.lastSeen = Date.now();
  if (name && p.name !== name) p.name = name;
  return p;
}

// ============================================================
//  COSMETICS
// ============================================================
const COSMETICS = {
  trail_fire:     { id:'trail_fire',     type:'trail', name:'Fire Trail',     price:100, emoji:'🔥' },
  trail_ice:      { id:'trail_ice',      type:'trail', name:'Ice Trail',      price:100, emoji:'❄️' },
  trail_gold:     { id:'trail_gold',     type:'trail', name:'Gold Trail',     price:200, emoji:'⭐' },
  trail_rainbow:  { id:'trail_rainbow',  type:'trail', name:'Rainbow Trail',  price:500, emoji:'🌈' },
  trail_void:     { id:'trail_void',     type:'trail', name:'Void Trail',     price:300, emoji:'🌑' },
  trail_electric: { id:'trail_electric', type:'trail', name:'Electric Trail', price:250, emoji:'⚡' },
  title_rookie:   { id:'title_rookie',   type:'title', name:'Rookie',         price:0,   emoji:'🐍', text:'[ROOKIE]' },
  title_hunter:   { id:'title_hunter',   type:'title', name:'Hunter',         price:150, emoji:'🏹', text:'[HUNTER]' },
  title_legend:   { id:'title_legend',   type:'title', name:'Legend',         price:400, emoji:'🏆', text:'[LEGEND]' },
  title_shadow:   { id:'title_shadow',   type:'title', name:'Shadow',         price:300, emoji:'🌑', text:'[SHADOW]' },
  title_god:      { id:'title_god',      type:'title', name:'God',            price:999, emoji:'⚡', text:'[GOD]' },
  badge_skull:    { id:'badge_skull',    type:'badge', name:'Skull Badge',    price:200, emoji:'💀' },
  badge_star:     { id:'badge_star',     type:'badge', name:'Star Badge',     price:150, emoji:'⭐' },
  badge_dragon:   { id:'badge_dragon',   type:'badge', name:'Dragon Badge',   price:350, emoji:'🐉' },
  badge_crown:    { id:'badge_crown',    type:'badge', name:'Crown Badge',    price:500, emoji:'👑' },
  owner_aura:     { id:'owner_aura',     type:'owner', name:'Z3N0 Aura',      price:-1,  emoji:'✨', ownerOnly:true },
  owner_trail:    { id:'owner_trail',    type:'owner', name:'Z3N0 Trail',     price:-1,  emoji:'👑', ownerOnly:true },
  owner_title:    { id:'owner_title',    type:'owner', name:'[Z3N0]',         price:-1,  emoji:'👑', ownerOnly:true, text:'[Z3N0]' },
  owner_explode:  { id:'owner_explode',  type:'owner', name:'Death Explosion',price:-1,  emoji:'💥', ownerOnly:true },
};

// ============================================================
//  GAME STATE
// ============================================================
let players = {};
let orbs    = {};
let activeEvent = null;
let leaderboard = [];

// ============================================================
//  ORBS
// ============================================================
const ORB_COLORS = ['#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff','#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff'];

function mkOrb() {
  return {
    id: uuidv4(),
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    color: ORB_COLORS[Math.random() * ORB_COLORS.length | 0],
    size: Math.random() * 6 + 4,
    value: (Math.random() * 3 | 0) + 1,
  };
}

for (let i = 0; i < ORB_COUNT; i++) { const o = mkOrb(); orbs[o.id] = o; }

function mkSegs(x, y, len) {
  const a = [];
  for (let i = 0; i < len; i++) a.push({ x: x - i * SEG_DIST, y });
  return a;
}

function dsq(a, b) { const dx = a.x-b.x, dy = a.y-b.y; return dx*dx+dy*dy; }

// ============================================================
//  AI BOTS
// ============================================================
const BOT_NAMES = ['Slinky','Viper','NightCrawler','Zapper','Coil','Fang','Serpentine','Nexus'];
const BOT_SKINS = ['fire','ice','toxic','gold','midnight','sunset','ocean','lava'];

function mkBot(i) {
  const x = Math.random()*(MAP_SIZE-600)+300, y = Math.random()*(MAP_SIZE-600)+300;
  return {
    id: 'bot_' + uuidv4(), socketId: null, isBot: true,
    name: BOT_NAMES[i % BOT_NAMES.length],
    skin: BOT_SKINS[i % BOT_SKINS.length],
    grantedSkin: null, playfabId: null,
    segments: mkSegs(x, y, INIT_LEN * 5),
    angle: Math.random() * Math.PI * 2,
    speed: SNAKE_SPEED, boosting: false,
    growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
    width: 8, dead: false, alive: true,
    isOwner: false, effect: null,
    equippedTrail: null, equippedTitle: '[BOT]', equippedBadge: '🤖',
    unlockedCosmetics: [],
    // AI state
    _turnTimer: 0, _boostTimer: 0, _wanderAngle: Math.random()*Math.PI*2,
  };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return a + d * t;
}

function tickBot(bot) {
  const h = bot.segments[0];
  bot._turnTimer--;
  bot._boostTimer--;

  // Wall avoidance (hard override)
  const M = 350;
  if (h.x < M)            { bot.angle = lerpAngle(bot.angle, 0, 0.25);          }
  else if (h.x > MAP_SIZE-M){ bot.angle = lerpAngle(bot.angle, Math.PI, 0.25);  }
  if (h.y < M)            { bot.angle = lerpAngle(bot.angle, Math.PI/2, 0.25);  }
  else if (h.y > MAP_SIZE-M){ bot.angle = lerpAngle(bot.angle, -Math.PI/2, 0.25);}

  // Seek nearest orb
  let nearOrb = null, nearD = 500*500;
  for (const oid in orbs) {
    const o = orbs[oid], d = dsq(h, o);
    if (d < nearD) { nearD = d; nearOrb = o; }
  }
  if (nearOrb) {
    bot.angle = lerpAngle(bot.angle, Math.atan2(nearOrb.y-h.y, nearOrb.x-h.x), 0.12);
  } else {
    if (bot._turnTimer <= 0) {
      bot._wanderAngle += (Math.random()-0.5)*1.4;
      bot._turnTimer = 40 + Math.random()*80 | 0;
    }
    bot.angle = lerpAngle(bot.angle, bot._wanderAngle, 0.08);
  }

  // Dodge other heads
  for (const pid in players) {
    const o = players[pid];
    if (o.id === bot.id || o.dead || !o.segments) continue;
    if (dsq(h, o.segments[0]) < 140*140) {
      bot.angle = lerpAngle(bot.angle, Math.atan2(h.y-o.segments[0].y, h.x-o.segments[0].x), 0.3);
      break;
    }
  }

  if (bot._boostTimer <= 0) {
    bot.boosting = Math.random() < 0.15;
    bot._boostTimer = 30 + Math.random()*50 | 0;
  }
}

function respawnBot(bot) {
  const x = Math.random()*(MAP_SIZE-600)+300, y = Math.random()*(MAP_SIZE-600)+300;
  bot.segments = mkSegs(x, y, INIT_LEN * 5);
  bot.angle = Math.random()*Math.PI*2;
  bot.dead = false; bot.alive = true;
  bot.score = 0; bot.sessionCoins = 0;
  bot.growBuffer = 0; bot.width = 8; bot.boosting = false;
}

for (let i = 0; i < BOT_COUNT; i++) { const b = mkBot(i); players[b.id] = b; }

// ============================================================
//  KILL
// ============================================================
function killPlayer(player, killer) {
  if (player.dead) return;
  player.dead = true;

  if (!player.isBot && player.socketId) {
    const pr = getProfile(player.playfabId, player.name);
    pr.totalScore += player.score;
    pr.coins      += player.sessionCoins;
    pr.gamesPlayed++;
    if (player.score > pr.highScore) pr.highScore = player.score;
  }

  // Drop orbs
  const dropN = Math.min(Math.floor(player.segments.length / 3), 60);
  const dropped = [];
  for (let i = 0; i < dropN; i++) {
    const seg = player.segments[Math.random() * player.segments.length | 0];
    const o = mkOrb();
    o.x = seg.x + (Math.random()-0.5)*60;
    o.y = seg.y + (Math.random()-0.5)*60;
    o.size = 10; o.value = 2;
    orbs[o.id] = o;
    dropped.push(o);
  }

  io.emit('playerDied', { id: player.id, killerName: killer ? killer.name : 'the wall', droppedOrbs: dropped });

  if (killer) {
    killer.score        += Math.floor(player.score * 0.3);
    killer.sessionCoins += Math.floor(player.score * 0.3);
    killer.kills = (killer.kills || 0) + 1;
    if (!killer.isBot) getProfile(killer.playfabId, killer.name).totalKills++;
    if (killer.socketId) io.to(killer.socketId).emit('killConfirmed', { victimName: player.name });
  }

  if (!player.isBot && player.socketId) {
    io.to(player.socketId).emit('youDied', {
      killerName: killer ? killer.name : 'the wall',
      coinsEarned: player.sessionCoins,
    });
    setTimeout(() => { delete players[player.id]; io.emit('playerLeft', player.id); }, 1000);
  } else if (player.isBot) {
    setTimeout(() => respawnBot(player), 3000 + Math.random()*2000);
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

    // Wall
    if (h.x < 0 || h.x > MAP_SIZE || h.y < 0 || h.y > MAP_SIZE) { killPlayer(p, null); continue; }

    // Orbs
    for (const oid in orbs) {
      const o = orbs[oid];
      const r = p.width + o.size;
      if (dsq(h, o) < r*r) {
        p.growBuffer    += GROW_PER_ORB * o.value;
        p.score         += o.value;
        p.sessionCoins  += o.value;
        delete orbs[oid];
        const neo = mkOrb(); orbs[neo.id] = neo;
        io.emit('orbEaten', { oid, newOrb: neo });
        break;
      }
    }
    if (p.dead) continue;

    // Snake vs snake
    for (const other of arr) {
      if (other.id === p.id || other.dead) continue;
      const segs = other.segments;
      // Body collision — check every 2nd segment for perf, always check first 5
      for (let si = 3; si < segs.length; si += (si < 20 ? 1 : 2)) {
        const r = p.width + other.width - 4;
        if (dsq(h, segs[si]) < r*r) { killPlayer(p, other); break; }
      }
      if (p.dead) break;
      // Head-on-head (smaller or equal loses)
      if (p.segments.length <= other.segments.length) {
        const r = p.width + other.width;
        if (dsq(h, segs[0]) < r*r) { killPlayer(p, other); break; }
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

    const spd = p.boosting ? BOOST_SPEED : (p.speed || SNAKE_SPEED);
    const h = p.segments[0];
    p.segments.unshift({ x: h.x + Math.cos(p.angle)*spd, y: h.y + Math.sin(p.angle)*spd });

    if (p.growBuffer > 0) p.growBuffer--;
    else p.segments.pop();

    p.width = Math.max(6, Math.min(24, 6 + p.segments.length * 0.03));

    // Boost sheds orbs
    if (p.boosting && p.segments.length > INIT_LEN * SEG_DIST && Math.random() < 0.25) {
      const tail = p.segments[p.segments.length - 1];
      const o = mkOrb(); o.x = tail.x; o.y = tail.y; o.size = 7; o.value = 1;
      orbs[o.id] = o; p.segments.pop();
    }
  }
  checkCollisions();

  // Update leaderboard
  leaderboard = Object.values(players)
    .filter(p => !p.dead)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({
      id: p.id, name: p.name, length: p.segments.length, score: p.score,
      skin: p.skin, isOwner: p.isOwner, isBot: p.isBot || false,
      equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge,
    }));
}

setInterval(gameTick, TICK_MS);

// ============================================================
//  STATE BROADCAST  (per-player, spatial culled)
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
    sessionCoins: p.sessionCoins,
  };
}

setInterval(() => {
  const alive = Object.values(players).filter(p => !p.dead);
  for (const pid in players) {
    const me = players[pid];
    if (me.isBot || !me.socketId || me.dead) continue;
    const mh = me.segments[0];
    const state = {};
    for (const p of alive) {
      if (p.id === me.id || dsq(mh, p.segments[0]) <= VIEW_RADIUS_SQ)
        state[p.id] = buildState(p);
    }
    io.to(me.socketId).emit('gameState', { players: state, leaderboard, activeEvent });
  }
}, BROADCAST_MS);

// ============================================================
//  SOCKET IO
// ============================================================
io.on('connection', socket => {

  socket.on('joinGame', ({ name, skin, password, playfabId }) => {
    const isOwner = password === OWNER_PASSWORD;
    const safeSkin = isOwner ? skin : (OWNER_SKINS.has(skin) ? 'classic' : skin);
    const x = Math.random()*(MAP_SIZE-600)+300, y = Math.random()*(MAP_SIZE-600)+300;
    const pr = getProfile(playfabId || null, name);

    const player = {
      id: uuidv4(), socketId: socket.id, isBot: false,
      name: name || 'Snake', skin: safeSkin, grantedSkin: null,
      playfabId: playfabId || null,
      segments: mkSegs(x, y, INIT_LEN),
      angle: 0, speed: SNAKE_SPEED, boosting: false,
      growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
      width: 8, dead: false, alive: true, isOwner, effect: null,
      equippedTrail: pr.equippedTrail,
      equippedTitle: isOwner ? '[Z3N0]' : pr.equippedTitle,
      equippedBadge: isOwner ? '👑' : pr.equippedBadge,
      unlockedCosmetics: isOwner ? Object.keys(COSMETICS) : [...pr.unlockedCosmetics],
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined', {
      playerId: player.id, isOwner, mapSize: MAP_SIZE,
      orbs: Object.values(orbs),
      profile: {
        coins: pr.coins, totalScore: pr.totalScore, totalKills: pr.totalKills,
        gamesPlayed: pr.gamesPlayed, highScore: pr.highScore,
        unlockedCosmetics: player.unlockedCosmetics,
        equippedTrail: player.equippedTrail, equippedTitle: player.equippedTitle,
        equippedBadge: player.equippedBadge, isLegacyAccount: !playfabId,
      },
      cosmeticsCatalog: COSMETICS,
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
    if (!c || c.ownerOnly || c.price < 0) { socket.emit('cosmeticError','Not available.'); return; }
    const pr = getProfile(p.playfabId, p.name);
    if (pr.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError','Already owned!'); return; }
    if (pr.coins < c.price) { socket.emit('cosmeticError',`Need ${c.price} coins (you have ${pr.coins})`); return; }
    pr.coins -= c.price;
    pr.unlockedCosmetics.push(cosmeticId);
    p.unlockedCosmetics.push(cosmeticId);
    socket.emit('cosmeticBought', { cosmeticId, newCoinBalance: pr.coins, unlockedCosmetics: pr.unlockedCosmetics });
  });

  socket.on('equipCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId]; if (!p) return;
    const c = COSMETICS[cosmeticId]; if (!c) return;
    if (!p.isOwner && !p.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError','You don\'t own this!'); return; }
    const pr = getProfile(p.playfabId, p.name);
    const t = c.type;
    if (t === 'trail') { p.equippedTrail = cosmeticId; pr.equippedTrail = cosmeticId; }
    else if (t === 'title' || t === 'owner') { if (c.text) { p.equippedTitle = c.text; pr.equippedTitle = c.text; } }
    else if (t === 'badge') { p.equippedBadge = c.emoji; pr.equippedBadge = c.emoji; }
    socket.emit('cosmeticEquipped', { cosmeticId, equippedTrail:p.equippedTrail, equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge });
  });

  socket.on('unequipCosmetic', ({ slot }) => {
    const p = players[socket.playerId]; if (!p) return;
    const pr = getProfile(p.playfabId, p.name);
    if (slot==='trail') { p.equippedTrail=null; pr.equippedTrail=null; }
    if (slot==='title') { p.equippedTitle=null; pr.equippedTitle=null; }
    if (slot==='badge') { p.equippedBadge=null; pr.equippedBadge=null; }
    socket.emit('cosmeticEquipped', { cosmeticId:null, equippedTrail:p.equippedTrail, equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge });
  });

  socket.on('ownerAction', ({ action, targetId, value, password }) => {
    if (password !== OWNER_PASSWORD) { socket.emit('ownerError','Invalid password.'); return; }
    const target = targetId ? Object.values(players).find(p => p.id === targetId) : null;

    switch (action) {
      case 'kick':
        if (target && !target.isBot) {
          io.to(target.socketId).emit('kicked', { reason: value || 'Kicked by owner.' });
          killPlayer(target, null);
          setTimeout(() => { const s = io.sockets.sockets.get(target.socketId); if(s) s.disconnect(true); }, 500);
          socket.emit('ownerSuccess', `Kicked ${target.name}`);
        } break;
      case 'instaKill':
        if (target) { killPlayer(target, null); if(target.socketId) io.to(target.socketId).emit('systemMessage','☠️ Eliminated by Z3N0'); socket.emit('ownerSuccess',`Killed ${target.name}`); } break;
      case 'giveSkin':
        if (target) { target.skin = value; target.grantedSkin = value; if(target.socketId) io.to(target.socketId).emit('skinGranted',{skin:value}); socket.emit('ownerSuccess',`Gave skin to ${target.name}`); } break;
      case 'giveSize':
        if (target) {
          const n = parseInt(value) || 50, tail = target.segments[target.segments.length-1];
          for (let i = 0; i < n * SEG_DIST; i++) target.segments.push({x:tail.x,y:tail.y});
          target.score += n * 10;
          if(target.socketId) io.to(target.socketId).emit('systemMessage',`📏 Z3N0 granted you +${n} size!`);
          socket.emit('ownerSuccess',`Gave ${n} size to ${target.name}`);
        } break;
      case 'giveCoins':
        if (target && !target.isBot) {
          const n = parseInt(value)||100, pr = getProfile(target.playfabId, target.name);
          pr.coins += n;
          if(target.socketId){ io.to(target.socketId).emit('coinsGranted',{amount:n,newBalance:pr.coins}); io.to(target.socketId).emit('systemMessage',`💰 Z3N0 gave you +${n} coins!`); }
          socket.emit('ownerSuccess',`Gave ${n} coins to ${target.name}`);
        } break;
      case 'giveCosmetic':
        if (target && !target.isBot) {
          const pr = getProfile(target.playfabId, target.name);
          if(!pr.unlockedCosmetics.includes(value)) pr.unlockedCosmetics.push(value);
          if(!target.unlockedCosmetics.includes(value)) target.unlockedCosmetics.push(value);
          if(target.socketId){ io.to(target.socketId).emit('cosmeticGranted',{cosmeticId:value,unlockedCosmetics:pr.unlockedCosmetics}); io.to(target.socketId).emit('systemMessage',`🎨 Z3N0 granted: ${COSMETICS[value]?.name||value}!`); }
          socket.emit('ownerSuccess',`Granted cosmetic to ${target.name}`);
        } break;
      case 'swapSize': {
        const p1 = Object.values(players).find(p=>p.id===targetId);
        const p2 = Object.values(players).find(p=>p.id===value);
        if (p1 && p2) {
          [p1.segments,p2.segments] = [p2.segments,p1.segments];
          [p1.score,p2.score] = [p2.score,p1.score];
          if(p1.socketId) io.to(p1.socketId).emit('systemMessage','🔄 Z3N0 swapped your size!');
          if(p2.socketId) io.to(p2.socketId).emit('systemMessage','🔄 Z3N0 swapped your size!');
          socket.emit('ownerSuccess',`Swapped ${p1.name} ↔ ${p2.name}`);
        } break;
      }
      case 'startEvent':
        activeEvent = { id:uuidv4(), type:value, name:eventName(value), startedAt:Date.now(), duration:60000 };
        applyEvent(activeEvent); io.emit('liveEvent', activeEvent);
        socket.emit('ownerSuccess',`Started: ${activeEvent.name}`);
        setTimeout(() => { activeEvent=null; resetEvent(); io.emit('eventEnded'); }, 60000);
        break;
      case 'endEvent': activeEvent=null; resetEvent(); io.emit('eventEnded'); socket.emit('ownerSuccess','Event ended.'); break;
      case 'broadcast': io.emit('ownerBroadcast',{message:value}); socket.emit('ownerSuccess','Broadcast sent!'); break;
      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p=>!p.dead).map(p => {
          const pr = p.isBot ? {coins:0,unlockedCosmetics:[]} : getProfile(p.playfabId,p.name);
          return { id:p.id, name:p.name, skin:p.skin, score:p.score, length:p.segments.length,
            isOwner:p.isOwner, isBot:p.isBot||false, coins:pr.coins, sessionCoins:p.sessionCoins,
            unlockedCosmetics:pr.unlockedCosmetics||[], equippedTrail:p.equippedTrail,
            equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge, kills:p.kills||0 };
        }));
        break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p && !p.isBot) {
      const pr = getProfile(p.playfabId, p.name);
      pr.coins += p.sessionCoins; p.sessionCoins = 0;
      killPlayer(p, null);
      setTimeout(() => { delete players[socket.playerId]; io.emit('playerLeft', socket.playerId); }, 500);
    }
  });
});

function eventName(t) {
  return {speedBoost:'⚡ HYPERSPEED FRENZY',orbFrenzy:'🌟 ORB OVERLOAD',shrinkAll:'💀 DEATH SHRINK',growAll:'🐍 TITAN RISE',darkness:'🌑 BLACKOUT',rainbow:'🌈 RAINBOW CHAOS'}[t]||t;
}
function applyEvent(ev) {
  if (ev.type==='speedBoost') for (const p of Object.values(players)) p.speed = SNAKE_SPEED*2;
  if (ev.type==='orbFrenzy') { for (let i=0;i<300;i++){const o=mkOrb();orbs[o.id]=o;} io.emit('orbFrenzy',Object.values(orbs)); }
  if (ev.type==='shrinkAll') for (const p of Object.values(players)) if(!p.isOwner) p.segments=p.segments.slice(0,Math.max(INIT_LEN*SEG_DIST,p.segments.length>>1));
  if (ev.type==='growAll') for (const p of Object.values(players)){const t=p.segments[p.segments.length-1];for(let i=0;i<100*SEG_DIST;i++)p.segments.push({x:t.x,y:t.y});}
}
function resetEvent() { for (const p of Object.values(players)) p.speed = SNAKE_SPEED; }

// ============================================================
//  HTTP API
// ============================================================
app.get('/api/leaderboard', (_, res) => res.json(leaderboard));
app.get('/api/stats', (_, res) => res.json({
  players: Object.values(players).filter(p=>!p.isBot&&!p.dead).length,
  bots:    Object.values(players).filter(p=>p.isBot&&!p.dead).length,
  orbs:    Object.keys(orbs).length,
  activeEvent: activeEvent?.name || null,
}));

const adminAuth = (req,res,next) => req.headers['x-admin-password']===ADMIN_PASS ? next() : res.status(401).json({error:'Unauthorized'});
app.post('/api/admin/auth',   (req,res) => res.json({success:req.body.password===ADMIN_PASS}));
app.get('/api/admin/cosmetics', adminAuth, (_,res) => res.json(COSMETICS));
app.get('/api/admin/players', adminAuth, (_,res) => {
  const live = {};
  Object.values(players).filter(p=>!p.isBot).forEach(p => { live[p.playfabId||('name:'+p.name.toLowerCase())] = p; });
  res.json(Object.values(playerDB).filter(pr=>!pr.id.startsWith('bot:')).map(pr => {
    const p = live[pr.id];
    return { name:pr.name, online:!!p, isPlayFab:pr.isPlayFab||false,
      coins:pr.coins+(p?p.sessionCoins:0), totalScore:pr.totalScore+(p?p.score:0),
      totalKills:pr.totalKills+(p?p.kills||0:0), gamesPlayed:pr.gamesPlayed, highScore:pr.highScore,
      unlockedCosmetics:pr.unlockedCosmetics, currentSize:p?p.segments.length:0,
      currentSkin:p?p.skin:null, firstSeen:pr.firstSeen, lastSeen:pr.lastSeen };
  }));
});
app.post('/api/admin/giveCoins', adminAuth, (req,res) => {
  const {name,amount} = req.body;
  const pr = Object.values(playerDB).find(p=>p.name.toLowerCase()===name.toLowerCase());
  if (!pr) return res.status(404).json({error:'Not found'});
  pr.coins += parseInt(amount)||0;
  const lp = Object.values(players).find(p=>!p.isBot&&p.name.toLowerCase()===name.toLowerCase());
  if (lp?.socketId) { io.to(lp.socketId).emit('coinsGranted',{amount,newBalance:pr.coins}); io.to(lp.socketId).emit('systemMessage',`💰 Admin gave you +${amount} coins!`); }
  res.json({success:true, newBalance:pr.coins});
});
app.post('/api/admin/setCoins', adminAuth, (req,res) => {
  const {name,amount} = req.body;
  const pr = Object.values(playerDB).find(p=>p.name.toLowerCase()===name.toLowerCase());
  if (!pr) return res.status(404).json({error:'Not found'});
  pr.coins = parseInt(amount)||0;
  res.json({success:true, newBalance:pr.coins});
});
app.post('/api/admin/giveCosmetic', adminAuth, (req,res) => {
  const {name,cosmeticId} = req.body;
  const pr = Object.values(playerDB).find(p=>p.name.toLowerCase()===name.toLowerCase());
  if (!pr) return res.status(404).json({error:'Not found'});
  if (!pr.unlockedCosmetics.includes(cosmeticId)) pr.unlockedCosmetics.push(cosmeticId);
  const lp = Object.values(players).find(p=>!p.isBot&&p.name.toLowerCase()===name.toLowerCase());
  if (lp?.socketId) { if(!lp.unlockedCosmetics.includes(cosmeticId)) lp.unlockedCosmetics.push(cosmeticId); io.to(lp.socketId).emit('cosmeticGranted',{cosmeticId,unlockedCosmetics:pr.unlockedCosmetics}); io.to(lp.socketId).emit('systemMessage',`🎨 Admin granted: ${COSMETICS[cosmeticId]?.name||cosmeticId}!`); }
  res.json({success:true});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Snake Server — port ${PORT}`);
  console.log(`👑 Owner: ${OWNER_PASSWORD}  🔐 Admin: ${ADMIN_PASS}`);
  console.log(`🤖 ${BOT_COUNT} AI bots active`);
});
