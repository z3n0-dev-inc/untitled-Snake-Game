const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(__dirname));
app.use(express.json());

// ============================================================
//  CONFIG
// ============================================================
const OWNER_PASSWORD = 'Z3N0ISKING';
const OWNER_NAME = 'Z3N0';
const MAP_SIZE = 6000;
const ORB_COUNT = 600;
const TICK_RATE = 30; // ms per tick
const SNAKE_SPEED = 2.8;
const BOOST_SPEED = 5.2;
const SEGMENT_DISTANCE = 12;
const INITIAL_LENGTH = 10;
const GROW_PER_ORB = 3;
const OWNER_SKINS = ['rainbow_god', 'void_lord', 'galaxy_emperor', 'neon_death', 'chrome_divine'];
const PUBLIC_SKINS = ['classic', 'fire', 'ice', 'toxic', 'gold', 'midnight', 'sunset', 'ocean', 'lava', 'forest'];

// ============================================================
//  GAME STATE
// ============================================================
let players = {};
let orbs = {};
let events = {};
let activeEvent = null;
let leaderboard = [];

// ============================================================
//  ORB GENERATION
// ============================================================
function createOrb(id) {
  const colors = ['#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff','#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff'];
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

// ============================================================
//  SNAKE HELPERS
// ============================================================
function createSegments(x, y, length) {
  const segs = [];
  for (let i = 0; i < length; i++) {
    segs.push({ x: x - i * SEGMENT_DISTANCE, y });
  }
  return segs;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getSnakeHead(player) {
  return player.segments[0];
}

// ============================================================
//  COLLISION
// ============================================================
function checkCollisions() {
  const pArr = Object.values(players);

  for (const p of pArr) {
    if (p.dead) continue;
    const head = getSnakeHead(p);

    // wall
    if (head.x < 0 || head.x > MAP_SIZE || head.y < 0 || head.y > MAP_SIZE) {
      killPlayer(p, null);
      continue;
    }

    // orbs
    for (const oid in orbs) {
      const orb = orbs[oid];
      if (dist(head, orb) < p.width + orb.size) {
        p.growBuffer += GROW_PER_ORB * orb.value;
        p.score += orb.value;
        delete orbs[oid];
        const newOrb = createOrb();
        orbs[newOrb.id] = newOrb;
        io.emit('orbEaten', { oid, newOrb });
        break;
      }
    }

    // other snakes
    for (const other of pArr) {
      if (other.id === p.id || other.dead) continue;
      // head vs body
      for (let si = 3; si < other.segments.length; si++) {
        if (dist(head, other.segments[si]) < p.width + other.width - 4) {
          killPlayer(p, other);
          break;
        }
      }
      // head vs head
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

  // drop orbs
  const dropCount = Math.min(Math.floor(player.segments.length / 2), 80);
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

  io.emit('playerDied', {
    id: player.id,
    killerName: killer ? killer.name : 'the wall',
    droppedOrbs
  });

  if (killer) {
    killer.score += Math.floor(player.score * 0.3);
    io.to(killer.socketId).emit('killConfirmed', { victimName: player.name });
  }

  // Notify the dead player
  io.to(player.socketId).emit('youDied', { killerName: killer ? killer.name : 'the wall' });

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
    const nx = head.x + Math.cos(p.angle) * speed;
    const ny = head.y + Math.sin(p.angle) * speed;

    p.segments.unshift({ x: nx, y: ny });

    if (p.growBuffer > 0) {
      p.growBuffer--;
    } else {
      p.segments.pop();
    }

    p.width = Math.max(6, Math.min(24, 6 + p.segments.length * 0.03));

    if (p.boosting && p.segments.length > INITIAL_LENGTH * SEGMENT_DISTANCE) {
      // shed orb while boosting
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
    .map(p => ({ name: p.name, length: p.segments.length, score: p.score, skin: p.skin, isOwner: p.isOwner, id: p.id }));
}

setInterval(gameTick, TICK_RATE);

// ============================================================
//  STATE BROADCAST
// ============================================================
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  const state = {};
  for (const pid in players) {
    const p = players[pid];
    if (p.dead) continue;
    // Only send nearby segments for performance, but send all for simplicity
    state[pid] = {
      segments: p.segments,
      angle: p.angle,
      skin: p.skin,
      name: p.name,
      width: p.width,
      boosting: p.boosting,
      isOwner: p.isOwner,
      grantedSkin: p.grantedSkin,
      effect: p.effect || null
    };
  }
  io.emit('gameState', { players: state, leaderboard, activeEvent });
}, TICK_RATE);

// ============================================================
//  SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinGame', ({ name, skin, password }) => {
    const isOwner = password === OWNER_PASSWORD;
    const actualSkin = isOwner ? skin : (OWNER_SKINS.includes(skin) ? 'classic' : skin);

    const startX = Math.random() * (MAP_SIZE - 500) + 250;
    const startY = Math.random() * (MAP_SIZE - 500) + 250;
    const segs = createSegments(startX, startY, INITIAL_LENGTH);

    const player = {
      id: uuidv4(),
      socketId: socket.id,
      name: name || 'Snake',
      skin: actualSkin,
      grantedSkin: null,
      segments: segs,
      angle: 0,
      speed: SNAKE_SPEED,
      boosting: false,
      growBuffer: 0,
      score: 0,
      width: 8,
      dead: false,
      alive: true,
      isOwner,
      effect: null
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined', {
      playerId: player.id,
      isOwner,
      mapSize: MAP_SIZE,
      orbs: Object.values(orbs)
    });

    io.emit('playerJoined', { id: player.id, name: player.name, isOwner });
    console.log(`${player.name} joined${isOwner ? ' [OWNER]' : ''}`);
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.playerId];
    if (!p || p.dead) return;
    p.angle = angle;
    p.boosting = boosting;
  });

  socket.on('respawn', ({ name, skin }) => {
    // handled by rejoin
  });

  // ============================================================
  //  OWNER PANEL EVENTS
  // ============================================================
  socket.on('ownerAction', ({ action, targetId, value, password }) => {
    if (password !== OWNER_PASSWORD) {
      socket.emit('ownerError', 'Invalid password.');
      return;
    }

    const target = targetId ? Object.values(players).find(p => p.id === targetId) : null;

    switch (action) {
      case 'kick':
        if (target) {
          io.to(target.socketId).emit('kicked', { reason: value || 'Kicked by owner.' });
          killPlayer(target, null);
          setTimeout(() => {
            const ts = io.sockets.sockets.get(target.socketId);
            if (ts) ts.disconnect(true);
          }, 500);
          socket.emit('ownerSuccess', `Kicked ${target.name}`);
        }
        break;

      case 'instaKill':
        if (target) {
          killPlayer(target, null);
          io.to(target.socketId).emit('systemMessage', '☠️ Eliminated by Z3N0');
          socket.emit('ownerSuccess', `Killed ${target.name}`);
        }
        break;

      case 'giveSkin':
        if (target) {
          target.skin = value;
          target.grantedSkin = value;
          io.to(target.socketId).emit('skinGranted', { skin: value });
          socket.emit('ownerSuccess', `Gave ${value} skin to ${target.name}`);
        }
        break;

      case 'giveSize':
        if (target) {
          const amount = parseInt(value) || 50;
          const segs = target.segments;
          const tail = segs[segs.length - 1];
          for (let i = 0; i < amount * SEGMENT_DISTANCE; i++) {
            segs.push({ x: tail.x, y: tail.y });
          }
          target.score += amount * 10;
          io.to(target.socketId).emit('systemMessage', `📏 Z3N0 granted you +${amount} size!`);
          socket.emit('ownerSuccess', `Gave ${amount} size to ${target.name}`);
        }
        break;

      case 'swapSize':
        const p1 = Object.values(players).find(p => p.id === targetId);
        const p2 = Object.values(players).find(p => p.id === value);
        if (p1 && p2) {
          const tmp = p1.segments;
          p1.segments = p2.segments;
          p2.segments = tmp;
          const tmpScore = p1.score;
          p1.score = p2.score;
          p2.score = tmpScore;
          io.to(p1.socketId).emit('systemMessage', `🔄 Z3N0 swapped your size!`);
          io.to(p2.socketId).emit('systemMessage', `🔄 Z3N0 swapped your size!`);
          socket.emit('ownerSuccess', `Swapped ${p1.name} ↔ ${p2.name}`);
        }
        break;

      case 'startEvent':
        activeEvent = {
          id: uuidv4(),
          type: value,
          name: getEventName(value),
          startedAt: Date.now(),
          duration: 60000
        };
        applyEvent(activeEvent);
        io.emit('liveEvent', activeEvent);
        socket.emit('ownerSuccess', `Started event: ${activeEvent.name}`);
        setTimeout(() => {
          activeEvent = null;
          resetEvent();
          io.emit('eventEnded');
        }, 60000);
        break;

      case 'endEvent':
        activeEvent = null;
        resetEvent();
        io.emit('eventEnded');
        socket.emit('ownerSuccess', 'Event ended.');
        break;

      case 'broadcast':
        io.emit('ownerBroadcast', { message: value });
        socket.emit('ownerSuccess', 'Message broadcast!');
        break;

      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p => !p.dead).map(p => ({
          id: p.id, name: p.name, skin: p.skin, score: p.score, length: p.segments.length, isOwner: p.isOwner
        })));
        break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p) {
      killPlayer(p, null);
      setTimeout(() => {
        delete players[socket.playerId];
        io.emit('playerLeft', socket.playerId);
      }, 500);
    }
    console.log('Client disconnected:', socket.id);
  });
});

function getEventName(type) {
  const names = {
    speedBoost: '⚡ HYPERSPEED FRENZY',
    orbFrenzy: '🌟 ORB OVERLOAD',
    shrinkAll: '💀 DEATH SHRINK',
    growAll: '🐍 TITAN RISE',
    darkness: '🌑 BLACKOUT',
    rainbow: '🌈 RAINBOW CHAOS'
  };
  return names[type] || type;
}

function applyEvent(event) {
  switch (event.type) {
    case 'speedBoost':
      for (const p of Object.values(players)) p.speed = SNAKE_SPEED * 2;
      break;
    case 'orbFrenzy':
      for (let i = 0; i < 300; i++) {
        const orb = createOrb();
        orbs[orb.id] = orb;
      }
      io.emit('orbFrenzy', Object.values(orbs));
      break;
    case 'shrinkAll':
      for (const p of Object.values(players)) {
        if (!p.isOwner) {
          p.segments = p.segments.slice(0, Math.max(INITIAL_LENGTH * SEGMENT_DISTANCE, Math.floor(p.segments.length / 2)));
        }
      }
      break;
    case 'growAll':
      for (const p of Object.values(players)) {
        const tail = p.segments[p.segments.length - 1];
        for (let i = 0; i < 100 * SEGMENT_DISTANCE; i++) {
          p.segments.push({ x: tail.x, y: tail.y });
        }
      }
      break;
  }
}

function resetEvent() {
  for (const p of Object.values(players)) {
    p.speed = SNAKE_SPEED;
  }
}

// ============================================================
//  HTTP ENDPOINTS
// ============================================================
app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboard);
});

app.get('/api/stats', (req, res) => {
  res.json({
    players: Object.keys(players).length,
    orbs: Object.keys(orbs).length,
    activeEvent: activeEvent ? activeEvent.name : null
  });
});

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Slither Server running on port ${PORT}`);
  console.log(`👑 Owner password: ${OWNER_PASSWORD}`);
});
