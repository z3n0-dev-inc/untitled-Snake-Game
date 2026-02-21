const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.use(express.json());

// ============================================================
//  CONFIG
// ============================================================
const OWNER_PASSWORD = 'Z3N0ISKING';
const ADMIN_SITE_PASSWORD = 'Z3N0ADMIN';
const MAP_SIZE = 6000;
const ORB_COUNT = 700;
const TICK_RATE = 30;
const SNAKE_SPEED = 2.8;
const BOOST_SPEED = 5.4;
const SEGMENT_DISTANCE = 12;
const INITIAL_LENGTH = 10;
const GROW_PER_ORB = 3;
const OWNER_NAMES = ['z3n0', 'Z3N0', 'z3n0isking'];

const OWNER_SKINS = [
  'rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine',
  'z3n0_exclusive','death_god','cosmos','blood_moon','electric_god',
  'shadow_reaper','golden_titan','void_walker','cosmic_serpent','divine_light'
];

// ============================================================
//  PLAYER DATABASE — persists across sessions by name (in-memory)
//  In production, replace with a real DB or file-based store.
// ============================================================
const playerDB = {};

function getOrCreateProfile(name) {
  const key = name.toLowerCase().trim();
  if (!playerDB[key]) {
    playerDB[key] = {
      name,
      coins: 0,
      totalScore: 0,
      totalKills: 0,
      gamesPlayed: 0,
      highScore: 0,
      unlockedCosmetics: ['title_rookie'],
      equippedTrail: null,
      equippedTitle: '[ROOKIE]',
      equippedBadge: null,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
  }
  playerDB[key].lastSeen = Date.now();
  return playerDB[key];
}

// ============================================================
//  FULL COSMETICS CATALOG — every cosmetic
// ============================================================
const COSMETICS = {
  // ── TRAILS ────────────────────────────────────────────────
  trail_fire:       { id:'trail_fire',       type:'trail',  name:'Fire Trail',        price:100,  emoji:'🔥', color:'#ff4400' },
  trail_ice:        { id:'trail_ice',        type:'trail',  name:'Ice Trail',          price:100,  emoji:'❄️', color:'#00ccff' },
  trail_gold:       { id:'trail_gold',       type:'trail',  name:'Gold Trail',         price:200,  emoji:'⭐', color:'#ffd700' },
  trail_rainbow:    { id:'trail_rainbow',    type:'trail',  name:'Rainbow Trail',      price:500,  emoji:'🌈', color:'rainbow' },
  trail_void:       { id:'trail_void',       type:'trail',  name:'Void Trail',         price:300,  emoji:'🌑', color:'#aa00ff' },
  trail_electric:   { id:'trail_electric',   type:'trail',  name:'Electric Trail',     price:250,  emoji:'⚡', color:'#00ffff' },
  trail_toxic:      { id:'trail_toxic',      type:'trail',  name:'Toxic Trail',        price:150,  emoji:'☣️', color:'#88ff00' },
  trail_blood:      { id:'trail_blood',      type:'trail',  name:'Blood Trail',        price:350,  emoji:'🩸', color:'#cc0000' },
  trail_galaxy:     { id:'trail_galaxy',     type:'trail',  name:'Galaxy Trail',       price:450,  emoji:'🌌', color:'#4488ff' },
  trail_sakura:     { id:'trail_sakura',     type:'trail',  name:'Sakura Trail',       price:200,  emoji:'🌸', color:'#ff88cc' },
  trail_shadow:     { id:'trail_shadow',     type:'trail',  name:'Shadow Trail',       price:300,  emoji:'👤', color:'#220044' },
  trail_crystal:    { id:'trail_crystal',    type:'trail',  name:'Crystal Trail',      price:400,  emoji:'💎', color:'#88eeff' },
  trail_lava:       { id:'trail_lava',       type:'trail',  name:'Lava Trail',         price:275,  emoji:'🌋', color:'#ff4400' },
  trail_neon:       { id:'trail_neon',       type:'trail',  name:'Neon Trail',         price:325,  emoji:'🎆', color:'#ff00ff' },
  trail_ocean:      { id:'trail_ocean',      type:'trail',  name:'Ocean Trail',        price:175,  emoji:'🌊', color:'#0088ff' },
  trail_storm:      { id:'trail_storm',      type:'trail',  name:'Storm Trail',        price:380,  emoji:'⛈️', color:'#aaaaff' },
  trail_dark_matter:{ id:'trail_dark_matter',type:'trail',  name:'Dark Matter Trail',  price:600,  emoji:'🕳️', color:'#110011' },
  trail_hologram:   { id:'trail_hologram',   type:'trail',  name:'Hologram Trail',     price:550,  emoji:'🔮', color:'#44ffff' },
  trail_supernova:  { id:'trail_supernova',  type:'trail',  name:'Supernova Trail',    price:750,  emoji:'💫', color:'#ffff00' },

  // ── TITLES ────────────────────────────────────────────────
  title_rookie:     { id:'title_rookie',     type:'title',  name:'Rookie',             price:0,    emoji:'🐍', text:'[ROOKIE]' },
  title_hunter:     { id:'title_hunter',     type:'title',  name:'Hunter',             price:150,  emoji:'🏹', text:'[HUNTER]' },
  title_legend:     { id:'title_legend',     type:'title',  name:'Legend',             price:400,  emoji:'🏆', text:'[LEGEND]' },
  title_shadow:     { id:'title_shadow',     type:'title',  name:'Shadow',             price:300,  emoji:'🌑', text:'[SHADOW]' },
  title_god:        { id:'title_god',        type:'title',  name:'God',                price:999,  emoji:'⚡', text:'[GOD]' },
  title_destroyer:  { id:'title_destroyer',  type:'title',  name:'Destroyer',          price:600,  emoji:'💀', text:'[DESTROYER]' },
  title_ghost:      { id:'title_ghost',      type:'title',  name:'Ghost',              price:250,  emoji:'👻', text:'[GHOST]' },
  title_king:       { id:'title_king',       type:'title',  name:'King',               price:800,  emoji:'👑', text:'[KING]' },
  title_demon:      { id:'title_demon',      type:'title',  name:'Demon',              price:500,  emoji:'😈', text:'[DEMON]' },
  title_viper:      { id:'title_viper',      type:'title',  name:'Viper',              price:200,  emoji:'🐍', text:'[VIPER]' },
  title_void:       { id:'title_void',       type:'title',  name:'Void Walker',        price:700,  emoji:'🕳️', text:'[VOID]' },
  title_titan:      { id:'title_titan',      type:'title',  name:'Titan',              price:850,  emoji:'🏔️', text:'[TITAN]' },
  title_ninja:      { id:'title_ninja',      type:'title',  name:'Ninja',              price:350,  emoji:'🥷', text:'[NINJA]' },
  title_omega:      { id:'title_omega',      type:'title',  name:'Omega',              price:950,  emoji:'Ω',  text:'[OMEGA]' },
  title_rookie2:    { id:'title_rookie2',    type:'title',  name:'Serpent',            price:50,   emoji:'🐉', text:'[SERPENT]' },

  // ── BADGES ────────────────────────────────────────────────
  badge_skull:      { id:'badge_skull',      type:'badge',  name:'Skull Badge',        price:200,  emoji:'💀' },
  badge_star:       { id:'badge_star',       type:'badge',  name:'Star Badge',         price:150,  emoji:'⭐' },
  badge_dragon:     { id:'badge_dragon',     type:'badge',  name:'Dragon Badge',       price:350,  emoji:'🐉' },
  badge_crown:      { id:'badge_crown',      type:'badge',  name:'Crown Badge',        price:500,  emoji:'👑' },
  badge_fire:       { id:'badge_fire',       type:'badge',  name:'Fire Badge',         price:180,  emoji:'🔥' },
  badge_lightning:  { id:'badge_lightning',  type:'badge',  name:'Lightning Badge',    price:220,  emoji:'⚡' },
  badge_diamond:    { id:'badge_diamond',    type:'badge',  name:'Diamond Badge',      price:600,  emoji:'💎' },
  badge_moon:       { id:'badge_moon',       type:'badge',  name:'Moon Badge',         price:250,  emoji:'🌙' },
  badge_snake:      { id:'badge_snake',      type:'badge',  name:'Snake Badge',        price:100,  emoji:'🐍' },
  badge_sword:      { id:'badge_sword',      type:'badge',  name:'Sword Badge',        price:300,  emoji:'⚔️' },
  badge_alien:      { id:'badge_alien',      type:'badge',  name:'Alien Badge',        price:400,  emoji:'👽' },
  badge_robot:      { id:'badge_robot',      type:'badge',  name:'Robot Badge',        price:350,  emoji:'🤖' },
  badge_bomb:       { id:'badge_bomb',       type:'badge',  name:'Bomb Badge',         price:275,  emoji:'💣' },
  badge_gem:        { id:'badge_gem',        type:'badge',  name:'Gem Badge',          price:450,  emoji:'💠' },
  badge_infinity:   { id:'badge_infinity',   type:'badge',  name:'Infinity Badge',     price:700,  emoji:'♾️' },

  // ── OWNER EXCLUSIVES ──────────────────────────────────────
  owner_aura:       { id:'owner_aura',       type:'owner',  name:'Z3N0 Aura',          price:-1,   emoji:'✨', ownerOnly:true, color:'#ffd700' },
  owner_trail:      { id:'owner_trail',      type:'owner',  name:'Z3N0 Trail',         price:-1,   emoji:'👑', ownerOnly:true, color:'#ffd700' },
  owner_title:      { id:'owner_title',      type:'owner',  name:'[Z3N0] Title',       price:-1,   emoji:'👑', ownerOnly:true, text:'[Z3N0]' },
  owner_explode:    { id:'owner_explode',    type:'owner',  name:'Death Explosion',    price:-1,   emoji:'💥', ownerOnly:true },
  owner_god_trail:  { id:'owner_god_trail',  type:'owner',  name:'God Trail',          price:-1,   emoji:'🌟', ownerOnly:true, color:'#ffffff' },
  owner_supreme:    { id:'owner_supreme',    type:'owner',  name:'[SUPREME] Title',    price:-1,   emoji:'🔱', ownerOnly:true, text:'[SUPREME]' },
  owner_creator:    { id:'owner_creator',    type:'owner',  name:'[CREATOR] Title',    price:-1,   emoji:'🌌', ownerOnly:true, text:'[CREATOR]' },
  owner_galaxy_trail:{ id:'owner_galaxy_trail',type:'owner',name:'Galaxy God Trail',   price:-1,   emoji:'🌌', ownerOnly:true, color:'#4444ff' },
  owner_rainbow_aura:{ id:'owner_rainbow_aura',type:'owner',name:'Rainbow Aura',       price:-1,   emoji:'🌈', ownerOnly:true, color:'rainbow' },
  owner_black_hole: { id:'owner_black_hole', type:'owner',  name:'Black Hole Trail',   price:-1,   emoji:'🕳️', ownerOnly:true, color:'#000000' },
  owner_divine_badge:{ id:'owner_divine_badge',type:'owner',name:'Divine Badge',       price:-1,   emoji:'🔱', ownerOnly:true },
  owner_death_badge:{ id:'owner_death_badge',type:'owner',  name:'Death God Badge',    price:-1,   emoji:'☠️', ownerOnly:true },
};

// ============================================================
//  GAME STATE
// ============================================================
let players = {};
let orbs = {};
let activeEvent = null;
let leaderboard = [];

function createOrb(id) {
  const colors = ['#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff','#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff','#ff88ff','#44ffff'];
  return {
    id: id || uuidv4(),
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    color: colors[Math.floor(Math.random() * colors.length)],
    size: Math.random() * 6 + 4,
    value: Math.floor(Math.random() * 3) + 1
  };
}

function initOrbs() {
  for (let i = 0; i < ORB_COUNT; i++) {
    const orb = createOrb();
    orbs[orb.id] = orb;
  }
}
initOrbs();

function createSegments(x, y, length) {
  const segs = [];
  for (let i = 0; i < length; i++) segs.push({ x: x - i * SEGMENT_DISTANCE, y });
  return segs;
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getSnakeHead(p) { return p.segments[0]; }

// ============================================================
//  COLLISION
// ============================================================
function checkCollisions() {
  const pArr = Object.values(players);
  for (const p of pArr) {
    if (p.dead || !p.alive) continue;
    const head = getSnakeHead(p);

    // Border collision
    if (head.x < 0 || head.x > MAP_SIZE || head.y < 0 || head.y > MAP_SIZE) {
      killPlayer(p, null);
      continue;
    }

    // Orb collision
    for (const oid in orbs) {
      const orb = orbs[oid];
      if (dist(head, orb) < p.width + orb.size) {
        p.growBuffer += GROW_PER_ORB * orb.value;
        p.score += orb.value;
        p.sessionCoins += orb.value;
        delete orbs[oid];
        const newOrb = createOrb();
        orbs[newOrb.id] = newOrb;
        io.emit('orbEaten', { oid, newOrb });
        break;
      }
    }

    // Snake collision
    for (const other of pArr) {
      if (other.id === p.id || other.dead) continue;

      // Body collision (skip first 3 segs to prevent false positives)
      for (let si = 3; si < other.segments.length; si++) {
        if (dist(head, other.segments[si]) < p.width + other.width - 4) {
          killPlayer(p, other);
          break;
        }
      }
      if (p.dead) break;

      // Head-on collision (smaller snake dies)
      if (p.segments.length <= other.segments.length) {
        if (dist(head, getSnakeHead(other)) < p.width + other.width) {
          killPlayer(p, other);
          break;
        }
      }
    }
  }
}

function killPlayer(player, killer) {
  if (player.dead) return;
  player.dead = true;

  const profile = getOrCreateProfile(player.name);
  profile.totalScore += player.score;
  const earnedCoins = player.sessionCoins;
  profile.coins += earnedCoins;
  profile.gamesPlayed++;
  if (player.score > profile.highScore) profile.highScore = player.score;

  // Drop orbs from body
  const dropCount = Math.min(Math.floor(player.segments.length / 2), 100);
  const droppedOrbs = [];
  for (let i = 0; i < dropCount; i++) {
    const seg = player.segments[Math.floor(Math.random() * player.segments.length)];
    const orb = createOrb();
    orb.x = seg.x + (Math.random() - 0.5) * 60;
    orb.y = seg.y + (Math.random() - 0.5) * 60;
    orb.size = 10;
    orb.value = 2;
    orbs[orb.id] = orb;
    droppedOrbs.push(orb);
  }

  io.emit('playerDied', { id: player.id, killerName: killer ? killer.name : 'the void', droppedOrbs });

  if (killer) {
    const killBonus = Math.floor(player.score * 0.3) + 10;
    killer.score += killBonus;
    killer.sessionCoins += killBonus;
    killer.kills = (killer.kills || 0) + 1;
    getOrCreateProfile(killer.name).totalKills++;
    io.to(killer.socketId).emit('killConfirmed', { victimName: player.name });
  }

  io.to(player.socketId).emit('youDied', {
    killerName: killer ? killer.name : 'the wall',
    coinsEarned: earnedCoins
  });

  // Persist the session coins now (already added above)
  player.sessionCoins = 0;

  setTimeout(() => {
    delete players[player.id];
    io.emit('playerLeft', player.id);
  }, 1000);
}

// ============================================================
//  GAME TICK
// ============================================================
function gameTick() {
  for (const pid in players) {
    const p = players[pid];
    if (p.dead || !p.alive) continue;

    const speed = p.boosting ? BOOST_SPEED : SNAKE_SPEED;
    const head = p.segments[0];
    p.segments.unshift({
      x: head.x + Math.cos(p.angle) * speed,
      y: head.y + Math.sin(p.angle) * speed
    });

    if (p.growBuffer > 0) p.growBuffer--;
    else p.segments.pop();

    p.width = Math.max(6, Math.min(26, 6 + p.segments.length * 0.03));

    // Boosting drops orbs from tail
    if (p.boosting && p.segments.length > INITIAL_LENGTH * SEGMENT_DISTANCE) {
      if (Math.random() < 0.3) {
        const tail = p.segments[p.segments.length - 1];
        const orb = createOrb();
        orb.x = tail.x;
        orb.y = tail.y;
        orb.size = 8;
        orb.value = 1;
        orbs[orb.id] = orb;
        p.segments.pop();
        io.emit('orbSpawned', orb);
      }
    }
  }
  checkCollisions();
  updateLeaderboard();
}

function updateLeaderboard() {
  leaderboard = Object.values(players)
    .filter(p => !p.dead)
    .sort((a, b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({
      name: p.name, length: p.segments.length, score: p.score,
      skin: p.skin, isOwner: p.isOwner, id: p.id,
      equippedTitle: p.equippedTitle, equippedBadge: p.equippedBadge
    }));
}

setInterval(gameTick, TICK_RATE);

// STATE BROADCAST — segment culling for performance
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  const state = {};
  for (const pid in players) {
    const p = players[pid];
    if (p.dead) continue;
    let segs = p.segments;
    // Cull distant segments for large snakes
    if (segs.length > 200) segs = segs.filter((_, i) => i < 20 || i % 2 === 0);
    state[pid] = {
      segments: segs, angle: p.angle, skin: p.skin, name: p.name,
      width: p.width, boosting: p.boosting, isOwner: p.isOwner,
      grantedSkin: p.grantedSkin, effect: p.effect || null,
      equippedTrail: p.equippedTrail || null,
      equippedTitle: p.equippedTitle || null,
      equippedBadge: p.equippedBadge || null,
      sessionCoins: p.sessionCoins
    };
  }
  io.emit('gameState', { players: state, leaderboard, activeEvent });
}, TICK_RATE);

// ============================================================
//  SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {

  socket.on('joinGame', ({ name, skin, password, playfabId, playfabToken }) => {
    const trimmedName = (name || 'Snake').trim().slice(0, 20);
    const isOwner = password === OWNER_PASSWORD;

    // Validate skin — block owner-only skins for non-owners
    const actualSkin = isOwner ? skin : (OWNER_SKINS.includes(skin) ? 'classic' : skin);

    const startX = Math.random() * (MAP_SIZE - 500) + 250;
    const startY = Math.random() * (MAP_SIZE - 500) + 250;
    const profile = getOrCreateProfile(trimmedName);

    // Owner gets all cosmetics automatically
    const unlockedCosmetics = isOwner
      ? Object.keys(COSMETICS)
      : [...profile.unlockedCosmetics];

    const player = {
      id: uuidv4(),
      socketId: socket.id,
      name: trimmedName,
      skin: actualSkin,
      grantedSkin: null,
      segments: createSegments(startX, startY, INITIAL_LENGTH),
      angle: 0,
      speed: SNAKE_SPEED,
      boosting: false,
      growBuffer: 0,
      score: 0,
      sessionCoins: 0,
      kills: 0,
      width: 8,
      dead: false,
      alive: true,
      isOwner,
      effect: null,
      equippedTrail: isOwner ? (profile.equippedTrail || 'owner_trail') : profile.equippedTrail,
      equippedTitle: isOwner ? '[Z3N0]' : (profile.equippedTitle || '[ROOKIE]'),
      equippedBadge: isOwner ? '🔱' : profile.equippedBadge,
      unlockedCosmetics
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined', {
      playerId: player.id,
      isOwner,
      mapSize: MAP_SIZE,
      orbs: Object.values(orbs),
      profile: {
        coins: profile.coins,
        totalScore: profile.totalScore,
        totalKills: profile.totalKills,
        gamesPlayed: profile.gamesPlayed,
        highScore: profile.highScore,
        unlockedCosmetics: player.unlockedCosmetics,
        equippedTrail: player.equippedTrail,
        equippedTitle: player.equippedTitle,
        equippedBadge: player.equippedBadge
      },
      cosmeticsCatalog: COSMETICS
    });

    io.emit('playerJoined', { id: player.id, name: player.name, isOwner });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.playerId];
    if (!p || p.dead) return;
    if (typeof angle === 'number' && isFinite(angle)) p.angle = angle;
    p.boosting = !!boosting;
  });

  socket.on('buyCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId];
    if (!p) return;
    const cosmetic = COSMETICS[cosmeticId];
    if (!cosmetic || cosmetic.ownerOnly || cosmetic.price < 0) {
      socket.emit('cosmeticError', 'Not available.');
      return;
    }
    const profile = getOrCreateProfile(p.name);
    if (profile.unlockedCosmetics.includes(cosmeticId)) {
      socket.emit('cosmeticError', 'Already owned!');
      return;
    }
    const totalCoins = profile.coins;
    if (totalCoins < cosmetic.price) {
      socket.emit('cosmeticError', `Need ${cosmetic.price} coins (you have ${totalCoins})`);
      return;
    }
    profile.coins -= cosmetic.price;
    profile.unlockedCosmetics.push(cosmeticId);
    p.unlockedCosmetics.push(cosmeticId);
    socket.emit('cosmeticBought', {
      cosmeticId,
      newCoinBalance: profile.coins,
      unlockedCosmetics: profile.unlockedCosmetics
    });
  });

  socket.on('equipCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId];
    if (!p) return;
    const cosmetic = COSMETICS[cosmeticId];
    if (!cosmetic) return;
    if (!p.isOwner && !p.unlockedCosmetics.includes(cosmeticId)) {
      socket.emit('cosmeticError', "You don't own this!");
      return;
    }
    const profile = getOrCreateProfile(p.name);
    const t = cosmetic.type;

    if (t === 'trail' || (t === 'owner' && cosmetic.color)) {
      p.equippedTrail = cosmeticId;
      profile.equippedTrail = cosmeticId;
    } else if (t === 'title' || (t === 'owner' && cosmetic.text)) {
      if (cosmetic.text) {
        p.equippedTitle = cosmetic.text;
        profile.equippedTitle = cosmetic.text;
      }
    } else if (t === 'badge' || (t === 'owner' && cosmetic.emoji && !cosmetic.text && !cosmetic.color)) {
      p.equippedBadge = cosmetic.emoji;
      profile.equippedBadge = cosmetic.emoji;
    }

    socket.emit('cosmeticEquipped', {
      cosmeticId,
      equippedTrail: p.equippedTrail,
      equippedTitle: p.equippedTitle,
      equippedBadge: p.equippedBadge
    });
  });

  socket.on('unequipCosmetic', ({ slot }) => {
    const p = players[socket.playerId];
    if (!p || p.isOwner) return; // Owner always keeps their cosmetics
    const profile = getOrCreateProfile(p.name);
    if (slot === 'trail') { p.equippedTrail = null; profile.equippedTrail = null; }
    if (slot === 'title') { p.equippedTitle = null; profile.equippedTitle = null; }
    if (slot === 'badge') { p.equippedBadge = null; profile.equippedBadge = null; }
    socket.emit('cosmeticEquipped', {
      cosmeticId: null,
      equippedTrail: p.equippedTrail,
      equippedTitle: p.equippedTitle,
      equippedBadge: p.equippedBadge
    });
  });

  socket.on('ownerAction', ({ action, targetId, value, password }) => {
    if (password !== OWNER_PASSWORD) {
      socket.emit('ownerError', 'Invalid password.');
      return;
    }
    const target = targetId ? Object.values(players).find(p => p.id === targetId) : null;

    switch (action) {
      case 'kick':
        if (target) {
          io.to(target.socketId).emit('kicked', { reason: value || 'Kicked by Z3N0.' });
          killPlayer(target, null);
          setTimeout(() => {
            const ts = io.sockets.sockets.get(target.socketId);
            if (ts) ts.disconnect(true);
          }, 500);
          socket.emit('ownerSuccess', `Kicked ${target.name}`);
        } break;

      case 'instaKill':
        if (target) {
          killPlayer(target, null);
          io.to(target.socketId).emit('systemMessage', '☠️ Eliminated by Z3N0');
          socket.emit('ownerSuccess', `Killed ${target.name}`);
        } break;

      case 'giveSkin':
        if (target) {
          target.skin = value;
          target.grantedSkin = value;
          io.to(target.socketId).emit('skinGranted', { skin: value });
          socket.emit('ownerSuccess', `Gave ${value} skin to ${target.name}`);
        } break;

      case 'giveSize':
        if (target) {
          const amount = parseInt(value) || 50;
          const tail = target.segments[target.segments.length - 1];
          for (let i = 0; i < amount * SEGMENT_DISTANCE; i++)
            target.segments.push({ x: tail.x, y: tail.y });
          target.score += amount * 10;
          io.to(target.socketId).emit('systemMessage', `📏 Z3N0 granted you +${amount} size!`);
          socket.emit('ownerSuccess', `Gave ${amount} size to ${target.name}`);
        } break;

      case 'giveCoins':
        if (target) {
          const amount = parseInt(value) || 100;
          const profile = getOrCreateProfile(target.name);
          profile.coins += amount;
          io.to(target.socketId).emit('coinsGranted', { amount, newBalance: profile.coins });
          io.to(target.socketId).emit('systemMessage', `💰 Z3N0 granted you +${amount} coins!`);
          socket.emit('ownerSuccess', `Gave ${amount} coins to ${target.name}`);
        } break;

      case 'giveCosmetic':
        if (target) {
          const profile = getOrCreateProfile(target.name);
          if (!profile.unlockedCosmetics.includes(value)) profile.unlockedCosmetics.push(value);
          if (!target.unlockedCosmetics.includes(value)) target.unlockedCosmetics.push(value);
          io.to(target.socketId).emit('cosmeticGranted', {
            cosmeticId: value,
            unlockedCosmetics: profile.unlockedCosmetics
          });
          io.to(target.socketId).emit('systemMessage', `🎨 Z3N0 granted you: ${COSMETICS[value]?.name || value}!`);
          socket.emit('ownerSuccess', `Gave cosmetic to ${target.name}`);
        } break;

      case 'swapSize': {
        const p1 = Object.values(players).find(p => p.id === targetId);
        const p2 = Object.values(players).find(p => p.id === value);
        if (p1 && p2) {
          [p1.segments, p2.segments] = [p2.segments, p1.segments];
          [p1.score, p2.score] = [p2.score, p1.score];
          io.to(p1.socketId).emit('systemMessage', '🔄 Z3N0 swapped your size!');
          io.to(p2.socketId).emit('systemMessage', '🔄 Z3N0 swapped your size!');
          socket.emit('ownerSuccess', `Swapped ${p1.name} ↔ ${p2.name}`);
        } break;
      }

      case 'startEvent':
        activeEvent = {
          id: uuidv4(), type: value, name: getEventName(value),
          startedAt: Date.now(), duration: 60000
        };
        applyEvent(activeEvent);
        io.emit('liveEvent', activeEvent);
        socket.emit('ownerSuccess', `Started event: ${activeEvent.name}`);
        setTimeout(() => { activeEvent = null; resetEvent(); io.emit('eventEnded'); }, 60000);
        break;

      case 'endEvent':
        activeEvent = null;
        resetEvent();
        io.emit('eventEnded');
        socket.emit('ownerSuccess', 'Event ended.');
        break;

      case 'broadcast':
        io.emit('ownerBroadcast', { message: value });
        socket.emit('ownerSuccess', 'Broadcast sent!');
        break;

      case 'teleport':
        if (target) {
          const tx = parseInt(value) || MAP_SIZE / 2;
          const ty = parseInt(targetId) || MAP_SIZE / 2;
          const head = target.segments[0];
          const dx = tx - head.x, dy = ty - head.y;
          target.segments = target.segments.map(s => ({ x: s.x + dx, y: s.y + dy }));
          socket.emit('ownerSuccess', `Teleported ${target.name}`);
        } break;

      case 'freezeAll':
        Object.values(players).forEach(p => { if (!p.isOwner) p.frozen = true; });
        setTimeout(() => Object.values(players).forEach(p => p.frozen = false), parseInt(value) * 1000 || 5000);
        io.emit('systemMessage', '🧊 Z3N0 froze the realm!');
        socket.emit('ownerSuccess', 'All players frozen!');
        break;

      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p => !p.dead).map(p => {
          const pr = getOrCreateProfile(p.name);
          return {
            id: p.id, name: p.name, skin: p.skin, score: p.score,
            length: p.segments.length, isOwner: p.isOwner,
            coins: pr.coins, sessionCoins: p.sessionCoins,
            unlockedCosmetics: pr.unlockedCosmetics,
            equippedTrail: p.equippedTrail,
            equippedTitle: p.equippedTitle,
            equippedBadge: p.equippedBadge,
            kills: p.kills || 0
          };
        }));
        break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p && !p.dead) {
      // Save session coins to profile on disconnect
      const profile = getOrCreateProfile(p.name);
      profile.coins += p.sessionCoins;
      profile.totalScore += p.score;
      profile.gamesPlayed++;
      if (p.score > profile.highScore) profile.highScore = p.score;
      p.sessionCoins = 0;
      killPlayer(p, null);
      setTimeout(() => {
        delete players[socket.playerId];
        io.emit('playerLeft', socket.playerId);
      }, 500);
    }
  });
});

// ============================================================
//  EVENTS
// ============================================================
function getEventName(type) {
  return {
    speedBoost: '⚡ HYPERSPEED FRENZY',
    orbFrenzy:  '🌟 ORB OVERLOAD',
    shrinkAll:  '💀 DEATH SHRINK',
    growAll:    '🐍 TITAN RISE',
    darkness:   '🌑 BLACKOUT',
    rainbow:    '🌈 RAINBOW CHAOS',
    coinRain:   '💰 COIN RAIN',
    godMode:    '⭐ GOD MODE'
  }[type] || type;
}

function applyEvent(event) {
  if (event.type === 'speedBoost')
    Object.values(players).forEach(p => p.speed = SNAKE_SPEED * 2);
  if (event.type === 'orbFrenzy') {
    for (let i = 0; i < 400; i++) { const o = createOrb(); orbs[o.id] = o; }
    io.emit('orbFrenzy', Object.values(orbs));
  }
  if (event.type === 'shrinkAll')
    Object.values(players).forEach(p => {
      if (!p.isOwner) p.segments = p.segments.slice(0, Math.max(INITIAL_LENGTH * SEGMENT_DISTANCE, Math.floor(p.segments.length / 2)));
    });
  if (event.type === 'growAll')
    Object.values(players).forEach(p => {
      const t = p.segments[p.segments.length - 1];
      for (let i = 0; i < 100 * SEGMENT_DISTANCE; i++) p.segments.push({ x: t.x, y: t.y });
    });
  if (event.type === 'coinRain')
    Object.values(players).forEach(p => {
      const profile = getOrCreateProfile(p.name);
      const bonus = 200;
      profile.coins += bonus;
      io.to(p.socketId).emit('coinsGranted', { amount: bonus, newBalance: profile.coins });
    });
}

function resetEvent() {
  Object.values(players).forEach(p => p.speed = SNAKE_SPEED);
}

// ============================================================
//  HTTP API
// ============================================================
app.get('/api/leaderboard', (req, res) => res.json(leaderboard));
app.get('/api/stats', (req, res) => res.json({
  players: Object.keys(players).length,
  orbs: Object.keys(orbs).length,
  activeEvent: activeEvent ? activeEvent.name : null
}));

const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-password'] === ADMIN_SITE_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/admin/auth', (req, res) => {
  res.json({ success: req.body.password === ADMIN_SITE_PASSWORD });
});

app.get('/api/admin/players', adminAuth, (req, res) => {
  const liveByName = {};
  Object.values(players).forEach(p => { liveByName[p.name.toLowerCase()] = p; });
  res.json(Object.values(playerDB).map(profile => {
    const live = liveByName[profile.name.toLowerCase()];
    return {
      name: profile.name, online: !!live,
      coins: profile.coins + (live ? live.sessionCoins : 0),
      totalScore: profile.totalScore + (live ? live.score : 0),
      totalKills: profile.totalKills + (live ? live.kills || 0 : 0),
      gamesPlayed: profile.gamesPlayed,
      highScore: profile.highScore,
      unlockedCosmetics: profile.unlockedCosmetics,
      equippedTrail: live ? live.equippedTrail : profile.equippedTrail,
      equippedTitle: live ? live.equippedTitle : profile.equippedTitle,
      equippedBadge: live ? live.equippedBadge : profile.equippedBadge,
      currentSize: live ? live.segments.length : 0,
      currentSkin: live ? live.skin : null,
      firstSeen: profile.firstSeen,
      lastSeen: profile.lastSeen
    };
  }));
});

app.get('/api/admin/cosmetics', adminAuth, (req, res) => res.json(COSMETICS));

app.post('/api/admin/giveCoins', adminAuth, (req, res) => {
  const { name, amount } = req.body;
  const profile = playerDB[name.toLowerCase()];
  if (!profile) return res.status(404).json({ error: 'Player not found' });
  profile.coins += parseInt(amount) || 0;
  const live = Object.values(players).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (live) {
    io.to(live.socketId).emit('coinsGranted', { amount, newBalance: profile.coins });
    io.to(live.socketId).emit('systemMessage', `💰 Admin granted you +${amount} coins!`);
  }
  res.json({ success: true, newBalance: profile.coins });
});

app.post('/api/admin/setCoins', adminAuth, (req, res) => {
  const { name, amount } = req.body;
  const profile = playerDB[name.toLowerCase()];
  if (!profile) return res.status(404).json({ error: 'Player not found' });
  profile.coins = parseInt(amount) || 0;
  res.json({ success: true, newBalance: profile.coins });
});

app.post('/api/admin/giveCosmetic', adminAuth, (req, res) => {
  const { name, cosmeticId } = req.body;
  const profile = playerDB[name.toLowerCase()];
  if (!profile) return res.status(404).json({ error: 'Player not found' });
  if (!profile.unlockedCosmetics.includes(cosmeticId)) profile.unlockedCosmetics.push(cosmeticId);
  const live = Object.values(players).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (live) {
    if (!live.unlockedCosmetics.includes(cosmeticId)) live.unlockedCosmetics.push(cosmeticId);
    io.to(live.socketId).emit('cosmeticGranted', { cosmeticId, unlockedCosmetics: profile.unlockedCosmetics });
    io.to(live.socketId).emit('systemMessage', `🎨 Admin granted: ${COSMETICS[cosmeticId]?.name || cosmeticId}!`);
  }
  res.json({ success: true });
});

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Slither Server running on port ${PORT}`);
  console.log(`👑 Owner password: ${OWNER_PASSWORD}`);
  console.log(`🔐 Admin password: ${ADMIN_SITE_PASSWORD}`);
  console.log(`🎨 Loaded ${Object.keys(COSMETICS).length} cosmetics`);
});
