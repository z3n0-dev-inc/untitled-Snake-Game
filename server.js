const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 8000,
  pingTimeout: 20000,
  perMessageDeflate: false
});

app.use(express.static(__dirname));
app.use(express.json());

// ============================================================
//  CONFIG
// ============================================================
const OWNER_PASSWORD   = 'Z3N0ISKING';
const ADMIN_SITE_PASSWORD = 'Z3N0ADMIN';
const MAP_SIZE         = 6000;
const ORB_COUNT        = 600;
const PHYSICS_RATE     = 33;   // ~30hz physics
const BROADCAST_RATE   = 50;   // ~20hz broadcast (enough, less CPU/bandwidth)
const SNAKE_SPEED      = 2.8;
const BOOST_SPEED      = 5.2;
const SEGMENT_DISTANCE = 12;
const INITIAL_LENGTH   = 10;
const GROW_PER_ORB     = 3;
const OWNER_SKINS = ['rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine','z3n0_exclusive','death_god','cosmos','blood_moon','electric_god'];

// ============================================================
//  UPGRADES  (balanced — useful but not game-breaking)
// ============================================================
const UPGRADES = {
  speed:  { id:'speed',  name:'Speed',   maxLevel:3, baseCost:80,  costMult:2.5, description:'+6% speed per level' },
  boost:  { id:'boost',  name:'Turbo',   maxLevel:3, baseCost:100, costMult:2.5, description:'+8% boost speed per level' },
  magnet: { id:'magnet', name:'Magnet',  maxLevel:3, baseCost:120, costMult:3.0, description:'Pulls nearby orbs toward you' },
  armor:  { id:'armor',  name:'Armor',   maxLevel:2, baseCost:200, costMult:4.0, description:'Absorbs wall hits (1-2 times)' },
  growth: { id:'growth', name:'Growth',  maxLevel:3, baseCost:60,  costMult:2.2, description:'+12% grow per orb' },
};
function getUpgradeCost(id, level) {
  const u = UPGRADES[id]; if (!u) return 9999;
  return Math.floor(u.baseCost * Math.pow(u.costMult, level));
}

// ============================================================
//  PLAYER DATABASE
// ============================================================
const playerDB = {};
function getOrCreateProfile(name) {
  const key = name.toLowerCase();
  if (!playerDB[key]) {
    playerDB[key] = {
      name, coins:0, totalScore:0, totalKills:0, gamesPlayed:0, highScore:0,
      unlockedCosmetics:['title_rookie'],
      upgrades:{ speed:0, boost:0, magnet:0, armor:0, growth:0 },
      equippedTrail:null, equippedTitle:null, equippedBadge:null,
      playfabId:null, firstSeen:Date.now(), lastSeen:Date.now()
    };
  }
  playerDB[key].lastSeen = Date.now();
  return playerDB[key];
}

// ============================================================
//  COSMETICS
// ============================================================
const COSMETICS = {
  trail_fire:    {id:'trail_fire',    type:'trail',name:'Fire Trail',   price:100, emoji:'🔥',color:'#ff4400'},
  trail_ice:     {id:'trail_ice',     type:'trail',name:'Ice Trail',    price:100, emoji:'❄️',color:'#00ccff'},
  trail_gold:    {id:'trail_gold',    type:'trail',name:'Gold Trail',   price:200, emoji:'⭐',color:'#ffd700'},
  trail_rainbow: {id:'trail_rainbow', type:'trail',name:'Rainbow Trail',price:500, emoji:'🌈',color:'rainbow'},
  trail_void:    {id:'trail_void',    type:'trail',name:'Void Trail',   price:300, emoji:'🌑',color:'#aa00ff'},
  trail_electric:{id:'trail_electric',type:'trail',name:'Elec Trail',   price:250, emoji:'⚡',color:'#00ffff'},
  title_rookie:  {id:'title_rookie',  type:'title',name:'Rookie',       price:0,   emoji:'🐍',text:'[ROOKIE]'},
  title_hunter:  {id:'title_hunter',  type:'title',name:'Hunter',       price:150, emoji:'🏹',text:'[HUNTER]'},
  title_legend:  {id:'title_legend',  type:'title',name:'Legend',       price:400, emoji:'🏆',text:'[LEGEND]'},
  title_shadow:  {id:'title_shadow',  type:'title',name:'Shadow',       price:300, emoji:'🌑',text:'[SHADOW]'},
  title_god:     {id:'title_god',     type:'title',name:'God',          price:999, emoji:'⚡',text:'[GOD]'},
  badge_skull:   {id:'badge_skull',   type:'badge',name:'Skull Badge',  price:200, emoji:'💀'},
  badge_star:    {id:'badge_star',    type:'badge',name:'Star Badge',   price:150, emoji:'⭐'},
  badge_dragon:  {id:'badge_dragon',  type:'badge',name:'Dragon Badge', price:350, emoji:'🐉'},
  badge_crown:   {id:'badge_crown',   type:'badge',name:'Crown Badge',  price:500, emoji:'👑'},
  owner_aura:    {id:'owner_aura',    type:'owner',name:'Z3N0 Aura',    price:-1,  emoji:'✨',ownerOnly:true},
  owner_trail:   {id:'owner_trail',   type:'owner',name:'Z3N0 Trail',   price:-1,  emoji:'👑',ownerOnly:true},
  owner_title:   {id:'owner_title',   type:'owner',name:'[Z3N0]',       price:-1,  emoji:'👑',ownerOnly:true,text:'[Z3N0]'},
  owner_explode: {id:'owner_explode', type:'owner',name:'Death Explosion',price:-1,emoji:'💥',ownerOnly:true},
};

// ============================================================
//  GAME STATE
// ============================================================
let players = {}, orbs = {}, activeEvent = null, leaderboard = [];

const ORB_COLORS = ['#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff','#aa44ff','#ff44aa','#00ffcc','#ff9900','#ffffff'];
function createOrb(id) {
  return {
    id: id||uuidv4(),
    x: Math.random()*MAP_SIZE, y: Math.random()*MAP_SIZE,
    color: ORB_COLORS[Math.floor(Math.random()*ORB_COLORS.length)],
    size: Math.random()*6+4, value: Math.floor(Math.random()*3)+1
  };
}
function initOrbs() { for (let i=0;i<ORB_COUNT;i++) { const o=createOrb(); orbs[o.id]=o; } }
initOrbs();

function createSegments(x,y,len) {
  const s=[];
  for (let i=0;i<len;i++) s.push({x:x-i*SEGMENT_DISTANCE,y});
  return s;
}
function dist(a,b) { const dx=a.x-b.x,dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }

// ============================================================
//  COLLISIONS
// ============================================================
function checkCollisions() {
  const pArr = Object.values(players);
  for (const p of pArr) {
    if (p.dead) continue;
    const head = p.segments[0];

    // Wall
    if (head.x<0||head.x>MAP_SIZE||head.y<0||head.y>MAP_SIZE) {
      if (p.armorHits>0 && !p.isBot) {
        p.armorHits--;
        p.angle += Math.PI;
        p.segments[0].x = Math.max(50,Math.min(MAP_SIZE-50,head.x));
        p.segments[0].y = Math.max(50,Math.min(MAP_SIZE-50,head.y));
        if (p.socketId) io.to(p.socketId).emit('systemMessage',`🛡️ Armor saved you! (${p.armorHits} left)`);
      } else { killPlayer(p,null); }
      continue;
    }

    // Orbs
    for (const oid in orbs) {
      const orb = orbs[oid];
      if (dist(head,orb) < p.width+orb.size) {
        const grow = 1 + (p.upgrades?.growth||0)*0.12;
        p.growBuffer += Math.floor(GROW_PER_ORB*orb.value*grow);
        p.score += orb.value; p.sessionCoins += orb.value;
        delete orbs[oid];
        const no = createOrb(); orbs[no.id]=no;
        io.emit('orbEaten',{oid,newOrb:no});
        break;
      }
    }

    // Bodies
    for (const other of pArr) {
      if (other.id===p.id||other.dead) continue;
      for (let si=3;si<other.segments.length;si++) {
        if (dist(head,other.segments[si]) < p.width+other.width-4) { killPlayer(p,other); break; }
      }
      if (!p.dead && p.segments.length<=other.segments.length) {
        if (dist(head,other.segments[0]) < p.width+other.width) { killPlayer(p,other); break; }
      }
    }
  }
}

function killPlayer(player, killer) {
  if (player.dead) return;
  player.dead = true;
  const profile = getOrCreateProfile(player.name);
  profile.totalScore += player.score;
  profile.coins += player.sessionCoins;
  profile.gamesPlayed++;
  if (player.score > profile.highScore) profile.highScore = player.score;

  const dropCount = Math.min(Math.floor(player.segments.length/2),80);
  const droppedOrbs = [];
  for (let i=0;i<dropCount;i++) {
    const seg = player.segments[Math.floor(Math.random()*player.segments.length)];
    const orb = createOrb();
    orb.x=seg.x+(Math.random()-0.5)*60; orb.y=seg.y+(Math.random()-0.5)*60;
    orb.size=10; orb.value=2;
    orbs[orb.id]=orb; droppedOrbs.push(orb);
  }
  io.emit('playerDied',{id:player.id, killerName:killer?killer.name:'the wall', droppedOrbs});

  if (killer) {
    killer.score += Math.floor(player.score*0.3);
    killer.sessionCoins += Math.floor(player.score*0.3);
    killer.kills = (killer.kills||0)+1;
    getOrCreateProfile(killer.name).totalKills++;
    if (killer.socketId) io.to(killer.socketId).emit('killConfirmed',{victimName:player.name});
  }

  if (player.socketId) {
    io.to(player.socketId).emit('youDied',{killerName:killer?killer.name:'the wall', coinsEarned:player.sessionCoins});
  }

  syncToPlayFab(player.name);
  setTimeout(()=>{ delete players[player.id]; io.emit('playerLeft',player.id); },1000);
}

// ============================================================
//  GAME TICK
// ============================================================
function gameTick() {
  // AI bots
  for (const pid in players) { const p=players[pid]; if (p.isBot&&!p.dead) tickBot(p); }

  for (const pid in players) {
    const p = players[pid];
    if (p.dead||!p.alive) continue;

    const speedMult = 1 + (p.upgrades?.speed||0)*0.06;
    const boostMult = 1 + (p.upgrades?.boost||0)*0.08;
    const speed = p.boosting ? BOOST_SPEED*boostMult : SNAKE_SPEED*speedMult;

    // Magnet
    const mag = p.upgrades?.magnet||0;
    if (mag>0) {
      const range = mag*45, head=p.segments[0];
      for (const oid in orbs) {
        const o=orbs[oid];
        const dx=head.x-o.x, dy=head.y-o.y, d=Math.sqrt(dx*dx+dy*dy);
        if (d<range&&d>1) { const pull=(0.6+mag*0.25)/d; o.x+=dx*pull; o.y+=dy*pull; }
      }
    }

    const head = p.segments[0];
    p.segments.unshift({x:head.x+Math.cos(p.angle)*speed, y:head.y+Math.sin(p.angle)*speed});
    if (p.growBuffer>0) p.growBuffer--;
    else p.segments.pop();
    p.width = Math.max(6,Math.min(24,6+p.segments.length*0.03));

    if (p.boosting && p.segments.length>INITIAL_LENGTH*SEGMENT_DISTANCE && Math.random()<0.3) {
      const tail=p.segments[p.segments.length-1];
      const orb=createOrb(); orb.x=tail.x; orb.y=tail.y; orb.size=8; orb.value=1;
      orbs[orb.id]=orb; p.segments.pop();
      io.emit('orbSpawned',orb);
    }
  }
  checkCollisions();
  updateLeaderboard();
}

function updateLeaderboard() {
  leaderboard = Object.values(players)
    .filter(p=>!p.dead)
    .sort((a,b)=>b.segments.length-a.segments.length)
    .slice(0,10)
    .map(p=>({name:p.name,length:p.segments.length,score:p.score,skin:p.skin,isOwner:p.isOwner,id:p.id,equippedTitle:p.equippedTitle,equippedBadge:p.equippedBadge,isBot:p.isBot||false}));
}

setInterval(gameTick, PHYSICS_RATE);

// ============================================================
//  BROADCAST — full state, but lean segment data
// ============================================================
setInterval(() => {
  if (!Object.keys(players).length) return;
  const state = {};
  for (const pid in players) {
    const p = players[pid];
    if (p.dead) continue;
    // Cull tail segments for large snakes — keep head detail, thin out middle/tail
    let segs = p.segments;
    if (segs.length > 80) {
      const culled = [];
      for (let i=0;i<segs.length;i++) {
        if (i<25 || i%2===0) culled.push(segs[i]);
      }
      segs = culled;
    }
    state[pid] = {
      segments:segs, angle:p.angle, skin:p.skin, name:p.name,
      width:p.width, boosting:p.boosting, isOwner:p.isOwner,
      grantedSkin:p.grantedSkin||null, effect:p.effect||null,
      equippedTrail:p.equippedTrail||null, equippedTitle:p.equippedTitle||null,
      equippedBadge:p.equippedBadge||null, sessionCoins:p.sessionCoins,
      upgrades:p.upgrades||{}, isBot:p.isBot||false, score:p.score||0
    };
  }
  io.emit('gameState',{players:state, leaderboard, activeEvent});
}, BROADCAST_RATE);

// ============================================================
//  SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {
  socket.on('joinGame', ({name, skin, password}) => {
    const isOwner = password===OWNER_PASSWORD;
    const actualSkin = isOwner ? skin : (OWNER_SKINS.includes(skin)?'classic':skin);
    const startX = Math.random()*(MAP_SIZE-500)+250;
    const startY = Math.random()*(MAP_SIZE-500)+250;
    const profile = getOrCreateProfile(name);

    const player = {
      id:uuidv4(), socketId:socket.id,
      name:name||'Snake', skin:actualSkin, grantedSkin:null,
      segments:createSegments(startX,startY,INITIAL_LENGTH),
      angle:0, boosting:false, growBuffer:0, score:0, sessionCoins:0, kills:0,
      width:8, dead:false, alive:true, isOwner, effect:null, isBot:false,
      equippedTrail:profile.equippedTrail,
      equippedTitle:isOwner?'[Z3N0]':profile.equippedTitle,
      equippedBadge:isOwner?'👑':profile.equippedBadge,
      unlockedCosmetics:isOwner?Object.keys(COSMETICS):[...profile.unlockedCosmetics],
      upgrades:{...profile.upgrades},
      armorHits:profile.upgrades.armor||0,
    };

    players[player.id] = player;
    socket.playerId = player.id;

    socket.emit('joined',{
      playerId:player.id, isOwner, mapSize:MAP_SIZE,
      orbs:Object.values(orbs),
      profile:{
        coins:profile.coins, totalScore:profile.totalScore, totalKills:profile.totalKills,
        gamesPlayed:profile.gamesPlayed, highScore:profile.highScore,
        unlockedCosmetics:player.unlockedCosmetics,
        equippedTrail:player.equippedTrail, equippedTitle:player.equippedTitle,
        equippedBadge:player.equippedBadge, upgrades:player.upgrades
      },
      upgradesCatalog:UPGRADES, cosmeticsCatalog:COSMETICS
    });
    io.emit('playerJoined',{id:player.id,name:player.name,isOwner});
  });

  socket.on('input',({angle,boosting})=>{
    const p=players[socket.playerId];
    if (!p||p.dead) return;
    p.angle=angle; p.boosting=boosting;
  });

  socket.on('buyCosmetic',({cosmeticId})=>{
    const p=players[socket.playerId]; if (!p) return;
    const c=COSMETICS[cosmeticId];
    if (!c||c.ownerOnly||c.price<0) { socket.emit('cosmeticError','Not available.'); return; }
    const pr=getOrCreateProfile(p.name);
    if (pr.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError','Already owned!'); return; }
    if (pr.coins<c.price) { socket.emit('cosmeticError',`Need ${c.price} coins`); return; }
    pr.coins-=c.price; pr.unlockedCosmetics.push(cosmeticId); p.unlockedCosmetics.push(cosmeticId);
    socket.emit('cosmeticBought',{cosmeticId,newCoinBalance:pr.coins,unlockedCosmetics:pr.unlockedCosmetics});
  });

  socket.on('equipCosmetic',({cosmeticId,slot})=>{
    const p=players[socket.playerId]; if (!p) return;
    const c=COSMETICS[cosmeticId]; if (!c) return;
    if (!p.isOwner&&!p.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError',"You don't own this!"); return; }
    const pr=getOrCreateProfile(p.name), t=c.type||slot;
    if (t==='trail') { p.equippedTrail=cosmeticId; pr.equippedTrail=cosmeticId; }
    else if (t==='title'||t==='owner') { if (c.text) { p.equippedTitle=c.text; pr.equippedTitle=c.text; } }
    else if (t==='badge') { p.equippedBadge=c.emoji; pr.equippedBadge=c.emoji; }
    socket.emit('cosmeticEquipped',{cosmeticId,equippedTrail:p.equippedTrail,equippedTitle:p.equippedTitle,equippedBadge:p.equippedBadge});
  });

  socket.on('unequipCosmetic',({slot})=>{
    const p=players[socket.playerId]; if (!p) return;
    const pr=getOrCreateProfile(p.name);
    if (slot==='trail'){p.equippedTrail=null;pr.equippedTrail=null;}
    if (slot==='title'){p.equippedTitle=null;pr.equippedTitle=null;}
    if (slot==='badge'){p.equippedBadge=null;pr.equippedBadge=null;}
    socket.emit('cosmeticEquipped',{cosmeticId:null,equippedTrail:p.equippedTrail,equippedTitle:p.equippedTitle,equippedBadge:p.equippedBadge});
  });

  socket.on('buyUpgrade',({upgradeId})=>{
    const p=players[socket.playerId]; if (!p||p.isBot) return;
    const u=UPGRADES[upgradeId]; if (!u) { socket.emit('upgradeError','Unknown upgrade.'); return; }
    const pr=getOrCreateProfile(p.name);
    const lvl=p.upgrades[upgradeId]||0;
    if (lvl>=u.maxLevel) { socket.emit('upgradeError','Already max level!'); return; }
    const cost=getUpgradeCost(upgradeId,lvl);
    const total=pr.coins+p.sessionCoins;
    if (total<cost) { socket.emit('upgradeError',`Need ${cost} coins (you have ${total})`); return; }
    if (p.sessionCoins>=cost) p.sessionCoins-=cost;
    else { pr.coins-=(cost-p.sessionCoins); p.sessionCoins=0; }
    p.upgrades[upgradeId]=lvl+1; pr.upgrades[upgradeId]=lvl+1;
    if (upgradeId==='armor') p.armorHits=p.upgrades.armor;
    socket.emit('upgradeBought',{upgradeId,newLevel:p.upgrades[upgradeId],upgrades:p.upgrades,sessionCoins:p.sessionCoins,profileCoins:pr.coins});
    socket.emit('systemMessage',`⬆️ ${u.name} → Level ${p.upgrades[upgradeId]}!`);
  });

  socket.on('ownerAction',({action,targetId,value,password})=>{
    if (password!==OWNER_PASSWORD) { socket.emit('ownerError','Invalid password.'); return; }
    const target = targetId ? Object.values(players).find(p=>p.id===targetId) : null;
    switch(action) {
      case 'kick': if(target){io.to(target.socketId).emit('kicked',{reason:value||'Kicked by owner.'});killPlayer(target,null);setTimeout(()=>{const ts=io.sockets.sockets.get(target.socketId);if(ts)ts.disconnect(true);},500);socket.emit('ownerSuccess',`Kicked ${target.name}`);} break;
      case 'instaKill': if(target){killPlayer(target,null);io.to(target.socketId).emit('systemMessage','☠️ Eliminated by Z3N0');socket.emit('ownerSuccess',`Killed ${target.name}`);} break;
      case 'giveSkin': if(target){target.skin=value;target.grantedSkin=value;io.to(target.socketId).emit('skinGranted',{skin:value});socket.emit('ownerSuccess',`Gave ${value} skin`);} break;
      case 'giveSize': if(target){const amt=parseInt(value)||50;const tail=target.segments[target.segments.length-1];for(let i=0;i<amt*SEGMENT_DISTANCE;i++)target.segments.push({x:tail.x,y:tail.y});target.score+=amt*10;io.to(target.socketId).emit('systemMessage',`📏 +${amt} size!`);socket.emit('ownerSuccess',`Gave ${amt} size`);} break;
      case 'giveCoins': if(target){const amt=parseInt(value)||100;const pr=getOrCreateProfile(target.name);pr.coins+=amt;io.to(target.socketId).emit('coinsGranted',{amount:amt,newBalance:pr.coins});io.to(target.socketId).emit('systemMessage',`💰 +${amt} coins!`);socket.emit('ownerSuccess',`Gave ${amt} coins`);} break;
      case 'giveCosmetic': if(target){const pr=getOrCreateProfile(target.name);if(!pr.unlockedCosmetics.includes(value))pr.unlockedCosmetics.push(value);if(!target.unlockedCosmetics.includes(value))target.unlockedCosmetics.push(value);io.to(target.socketId).emit('cosmeticGranted',{cosmeticId:value,unlockedCosmetics:pr.unlockedCosmetics});socket.emit('ownerSuccess',`Gave cosmetic`);} break;
      case 'swapSize': {const p1=Object.values(players).find(p=>p.id===targetId);const p2=Object.values(players).find(p=>p.id===value);if(p1&&p2){[p1.segments,p2.segments]=[p2.segments,p1.segments];[p1.score,p2.score]=[p2.score,p1.score];io.to(p1.socketId).emit('systemMessage','🔄 Size swapped!');io.to(p2.socketId).emit('systemMessage','🔄 Size swapped!');socket.emit('ownerSuccess','Swapped!');}} break;
      case 'startEvent': activeEvent={id:uuidv4(),type:value,name:getEventName(value),startedAt:Date.now(),duration:60000};applyEvent(activeEvent);io.emit('liveEvent',activeEvent);socket.emit('ownerSuccess',`Started: ${activeEvent.name}`);setTimeout(()=>{activeEvent=null;resetEvent();io.emit('eventEnded');},60000); break;
      case 'endEvent': activeEvent=null;resetEvent();io.emit('eventEnded');socket.emit('ownerSuccess','Event ended.'); break;
      case 'broadcast': io.emit('ownerBroadcast',{message:value});socket.emit('ownerSuccess','Sent!'); break;
      case 'getPlayers': socket.emit('playerList',Object.values(players).filter(p=>!p.dead).map(p=>{const pr=getOrCreateProfile(p.name);return{id:p.id,name:p.name,skin:p.skin,score:p.score,length:p.segments.length,isOwner:p.isOwner,coins:pr.coins,sessionCoins:p.sessionCoins,unlockedCosmetics:pr.unlockedCosmetics,equippedTrail:p.equippedTrail,equippedTitle:p.equippedTitle,equippedBadge:p.equippedBadge,kills:p.kills||0};})); break;
    }
  });

  socket.on('disconnect',()=>{
    const p=players[socket.playerId]; if (!p) return;
    const pr=getOrCreateProfile(p.name);
    pr.coins+=p.sessionCoins; p.sessionCoins=0;
    killPlayer(p,null);
    setTimeout(()=>{delete players[socket.playerId];io.emit('playerLeft',socket.playerId);},500);
  });
});

// ============================================================
//  EVENTS
// ============================================================
function getEventName(t){return{speedBoost:'⚡ HYPERSPEED FRENZY',orbFrenzy:'🌟 ORB OVERLOAD',shrinkAll:'💀 DEATH SHRINK',growAll:'🐍 TITAN RISE',darkness:'🌑 BLACKOUT',rainbow:'🌈 RAINBOW CHAOS'}[t]||t;}
function applyEvent(ev){
  if(ev.type==='speedBoost')for(const p of Object.values(players))p.speed=SNAKE_SPEED*2;
  if(ev.type==='orbFrenzy'){for(let i=0;i<300;i++){const o=createOrb();orbs[o.id]=o;}io.emit('orbFrenzy',Object.values(orbs));}
  if(ev.type==='shrinkAll')for(const p of Object.values(players))if(!p.isOwner)p.segments=p.segments.slice(0,Math.max(INITIAL_LENGTH*SEGMENT_DISTANCE,Math.floor(p.segments.length/2)));
  if(ev.type==='growAll')for(const p of Object.values(players)){const t=p.segments[p.segments.length-1];for(let i=0;i<100*SEGMENT_DISTANCE;i++)p.segments.push({x:t.x,y:t.y});}
}
function resetEvent(){for(const p of Object.values(players))p.speed=SNAKE_SPEED;}

// ============================================================
//  AI BOTS
// ============================================================
const BOT_NAMES = ['SERPENTINE','VIPER-X','NULL_BYTE'];
const BOT_SKINS = ['fire','ice','toxic'];
const BOT_PERSONALITIES = ['aggressive','defensive','hunter'];

function createBot(i) {
  const startX=Math.random()*(MAP_SIZE-1000)+500, startY=Math.random()*(MAP_SIZE-1000)+500;
  const bot = {
    id:'bot_'+uuidv4(), socketId:null,
    name:BOT_NAMES[i%BOT_NAMES.length], skin:BOT_SKINS[i%BOT_SKINS.length],
    grantedSkin:null, isOwner:false, isBot:true,
    personality:BOT_PERSONALITIES[i%BOT_PERSONALITIES.length],
    segments:createSegments(startX,startY,INITIAL_LENGTH*3),
    angle:Math.random()*Math.PI*2, boosting:false,
    growBuffer:0, score:0, sessionCoins:0, kills:0,
    width:8, dead:false, alive:true, effect:null,
    equippedTrail:null, equippedTitle:'[BOT]', equippedBadge:'🤖',
    unlockedCosmetics:[], upgrades:{speed:0,boost:0,magnet:0,armor:0,growth:0},
    armorHits:0,
    targetAngle:Math.random()*Math.PI*2, wanderTimer:0, evadeTimer:0, boostCooldown:0,
  };
  players[bot.id]=bot;
  io.emit('playerJoined',{id:bot.id,name:bot.name,isOwner:false});
  return bot;
}

function respawnBot(bot) {
  const x=Math.random()*(MAP_SIZE-1000)+500, y=Math.random()*(MAP_SIZE-1000)+500;
  Object.assign(bot,{segments:createSegments(x,y,INITIAL_LENGTH*3),angle:Math.random()*Math.PI*2,dead:false,alive:true,score:0,sessionCoins:0,kills:0,growBuffer:0,width:8,boostCooldown:0,evadeTimer:0,boosting:false});
  io.emit('playerJoined',{id:bot.id,name:bot.name,isOwner:false});
}

function tickBot(bot) {
  const head=bot.segments[0], pArr=Object.values(players);
  let dangerAngle=null;

  // Wall avoidance
  const lx=head.x+Math.cos(bot.angle)*150, ly=head.y+Math.sin(bot.angle)*150;
  if (lx<200||lx>MAP_SIZE-200||ly<200||ly>MAP_SIZE-200)
    dangerAngle=Math.atan2(MAP_SIZE/2-head.y, MAP_SIZE/2-head.x);

  // Body avoidance
  if (!dangerAngle) {
    outer: for (const other of pArr) {
      if (other.id===bot.id||other.dead) continue;
      for (let si=2;si<Math.min(other.segments.length,30);si++) {
        if (dist(head,other.segments[si])<70) {
          dangerAngle=Math.atan2(head.y-other.segments[si].y, head.x-other.segments[si].x);
          bot.evadeTimer=25; break outer;
        }
      }
    }
  }
  if (bot.evadeTimer>0) bot.evadeTimer--;

  let desired=bot.angle;
  bot.boosting=false;
  bot.boostCooldown=Math.max(0,bot.boostCooldown-1);

  if (dangerAngle!==null) {
    desired=dangerAngle;
  } else if (bot.personality==='aggressive'||bot.personality==='hunter') {
    let nearest=null, nd=Infinity;
    for (const o of pArr) { if (o.id===bot.id||o.dead||o.isBot) continue; const d=dist(head,o.segments[0]); if(d<nd){nd=d;nearest=o;} }
    if (nearest&&nd<700) {
      desired=Math.atan2(nearest.segments[0].y-head.y, nearest.segments[0].x-head.x);
      if (nd<300&&bot.boostCooldown===0){bot.boosting=true;bot.boostCooldown=50;}
    } else desired=botSeekOrb(bot,head);
  } else {
    desired=botSeekOrb(bot,head);
    for (const o of pArr) {
      if (o.id===bot.id||o.dead||o.isBot) continue;
      if (dist(head,o.segments[0])<250&&o.segments.length>bot.segments.length) {
        desired=Math.atan2(head.y-o.segments[0].y, head.x-o.segments[0].x);
        if (bot.boostCooldown===0){bot.boosting=true;bot.boostCooldown=35;}
        break;
      }
    }
  }

  let diff=desired-bot.angle;
  while(diff>Math.PI)diff-=Math.PI*2; while(diff<-Math.PI)diff+=Math.PI*2;
  bot.angle+=Math.sign(diff)*Math.min(Math.abs(diff),0.09);
}

function botSeekOrb(bot,head) {
  let nearest=null,nd=Infinity;
  for (const oid in orbs){const o=orbs[oid];const d=dist(head,o);if(d<nd){nd=d;nearest=o;}}
  if (nearest) return Math.atan2(nearest.y-head.y,nearest.x-head.x);
  bot.wanderTimer--;
  if (bot.wanderTimer<=0){bot.targetAngle=Math.random()*Math.PI*2;bot.wanderTimer=80+Math.floor(Math.random()*80);}
  return bot.targetAngle;
}

setTimeout(()=>{ for(let i=0;i<3;i++) createBot(i); }, 1500);
setInterval(()=>{
  for (const pid in players) { const p=players[pid]; if(p.isBot&&p.dead) setTimeout(()=>respawnBot(p),3000); }
  const liveBots=Object.values(players).filter(p=>p.isBot&&!p.dead);
  if (liveBots.length<3) { for(let i=liveBots.length;i<3;i++) { if(!Object.values(players).find(p=>p.isBot&&p.name===BOT_NAMES[i%3]&&!p.dead)) createBot(i); } }
},5000);

// ============================================================
//  HTTP API
// ============================================================
app.get('/api/leaderboard',(req,res)=>res.json(leaderboard));
app.get('/api/stats',(req,res)=>res.json({players:Object.keys(players).length,orbs:Object.keys(orbs).length,activeEvent:activeEvent?.name||null}));

const adminAuth=(req,res,next)=>{if(req.headers['x-admin-password']===ADMIN_SITE_PASSWORD)return next();res.status(401).json({error:'Unauthorized'});};
app.post('/api/admin/auth',(req,res)=>res.json({success:req.body.password===ADMIN_SITE_PASSWORD}));
app.get('/api/admin/players',adminAuth,(req,res)=>{
  const live={};Object.values(players).forEach(p=>{live[p.name.toLowerCase()]=p;});
  res.json(Object.values(playerDB).map(pr=>{const l=live[pr.name.toLowerCase()];return{name:pr.name,online:!!l,coins:pr.coins+(l?l.sessionCoins:0),totalScore:pr.totalScore+(l?l.score:0),totalKills:pr.totalKills+(l?l.kills||0:0),gamesPlayed:pr.gamesPlayed,highScore:pr.highScore,unlockedCosmetics:pr.unlockedCosmetics,equippedTrail:l?l.equippedTrail:pr.equippedTrail,equippedTitle:l?l.equippedTitle:pr.equippedTitle,equippedBadge:l?l.equippedBadge:pr.equippedBadge,currentSize:l?l.segments.length:0,currentSkin:l?l.skin:null,firstSeen:pr.firstSeen,lastSeen:pr.lastSeen};}));
});
app.get('/api/admin/cosmetics',adminAuth,(req,res)=>res.json(COSMETICS));
app.post('/api/admin/giveCoins',adminAuth,(req,res)=>{const{name,amount}=req.body;const pr=playerDB[name.toLowerCase()];if(!pr)return res.status(404).json({error:'Not found'});pr.coins+=parseInt(amount)||0;const l=Object.values(players).find(p=>p.name.toLowerCase()===name.toLowerCase());if(l){io.to(l.socketId).emit('coinsGranted',{amount,newBalance:pr.coins});io.to(l.socketId).emit('systemMessage',`💰 +${amount} coins!`);}res.json({success:true,newBalance:pr.coins});});
app.post('/api/admin/setCoins',adminAuth,(req,res)=>{const{name,amount}=req.body;const pr=playerDB[name.toLowerCase()];if(!pr)return res.status(404).json({error:'Not found'});pr.coins=parseInt(amount)||0;res.json({success:true,newBalance:pr.coins});});
app.post('/api/admin/giveCosmetic',adminAuth,(req,res)=>{const{name,cosmeticId}=req.body;const pr=playerDB[name.toLowerCase()];if(!pr)return res.status(404).json({error:'Not found'});if(!pr.unlockedCosmetics.includes(cosmeticId))pr.unlockedCosmetics.push(cosmeticId);const l=Object.values(players).find(p=>p.name.toLowerCase()===name.toLowerCase());if(l){if(!l.unlockedCosmetics.includes(cosmeticId))l.unlockedCosmetics.push(cosmeticId);io.to(l.socketId).emit('cosmeticGranted',{cosmeticId,unlockedCosmetics:pr.unlockedCosmetics});}res.json({success:true});});

// ============================================================
//  PLAYFAB — auto-register on game join, sync on death
// ============================================================
const PLAYFAB_TITLE_ID = process.env.PLAYFAB_TITLE_ID || '';
const PLAYFAB_SECRET   = process.env.PLAYFAB_SECRET   || '';

console.log('PLAYFAB_TITLE_ID:', PLAYFAB_TITLE_ID ? `SET (${PLAYFAB_TITLE_ID})` : 'MISSING');
console.log('PLAYFAB_SECRET:',   PLAYFAB_SECRET   ? 'SET'                       : 'MISSING');

async function playfabRequest(endpoint, body) {
  if (!PLAYFAB_TITLE_ID || !PLAYFAB_SECRET) return null;
  const https = require('https');
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: `${PLAYFAB_TITLE_ID}.playfabapi.com`,
      path: endpoint, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'X-SecretKey':PLAYFAB_SECRET}
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve(null);} });
    });
    req.on('error',()=>resolve(null));
    req.write(payload); req.end();
  });
}

// Auto-register player in PlayFab on first join (transparent, no button needed)
async function pfEnsurePlayer(name) {
  if (!PLAYFAB_TITLE_ID || !PLAYFAB_SECRET) return;
  const profile = playerDB[name.toLowerCase()];
  if (!profile || profile.playfabId) return; // already registered
  try {
    const customId = 'z3n0_' + name.toLowerCase().replace(/[^a-z0-9]/g,'_');
    const res = await playfabRequest('/Server/LoginWithServerCustomId',{
      ServerCustomId: customId, CreateAccount: true,
      InfoRequestParameters:{ GetUserAccountInfo:true }
    });
    if (res?.code===200) {
      profile.playfabId = res.data.PlayFabId;
      console.log(`PlayFab: registered ${name} → ${profile.playfabId}`);
    }
  } catch(e) { /* silent */ }
}

async function syncToPlayFab(name) {
  if (!PLAYFAB_TITLE_ID || !PLAYFAB_SECRET) return;
  const profile = playerDB[name.toLowerCase()];
  if (!profile) return;
  // Register first if not yet
  if (!profile.playfabId) await pfEnsurePlayer(name);
  if (!profile.playfabId) return;
  try {
    await playfabRequest('/Server/UpdatePlayerStatistics',{
      PlayFabId:profile.playfabId,
      Statistics:[
        {StatisticName:'TotalScore', Value:profile.totalScore},
        {StatisticName:'TotalKills', Value:profile.totalKills},
        {StatisticName:'GamesPlayed',Value:profile.gamesPlayed},
        {StatisticName:'HighScore',  Value:profile.highScore},
        {StatisticName:'Coins',      Value:profile.coins}
      ]
    });
    await playfabRequest('/Server/UpdateUserTitleDisplayName',{PlayFabId:profile.playfabId,DisplayName:profile.name.substring(0,25)});
  } catch(e) { /* silent */ }
}

// Register on join too (fire and forget)
const _origJoin = io.on.bind(io);
// Hook: after joinGame, auto-register
setInterval(async ()=>{
  for (const key in playerDB) {
    const pr = playerDB[key];
    if (!pr.playfabId && !pr._pfPending) {
      pr._pfPending = true;
      await pfEnsurePlayer(pr.name);
      pr._pfPending = false;
    }
  }
}, 10000);

// Manual link endpoint (for ACCOUNT tab)
app.post('/api/playfab/link', async (req,res)=>{
  if (!PLAYFAB_TITLE_ID||!PLAYFAB_SECRET) return res.status(503).json({error:'PlayFab not configured on server.'});
  const {playerName,displayName}=req.body;
  if (!playerName) return res.status(400).json({error:'playerName required'});
  try {
    const customId='z3n0_'+playerName.toLowerCase().replace(/[^a-z0-9]/g,'_');
    const loginRes=await playfabRequest('/Server/LoginWithServerCustomId',{ServerCustomId:customId,CreateAccount:true,InfoRequestParameters:{GetUserAccountInfo:true}});
    if (!loginRes||loginRes.code!==200) return res.status(400).json({error:loginRes?.errorMessage||`PlayFab error (code ${loginRes?.code})`});
    const playfabId=loginRes.data.PlayFabId, newlyCreated=loginRes.data.NewlyCreated;
    const profile=playerDB[playerName.toLowerCase()];
    if (profile) profile.playfabId=playfabId;
    if (displayName) await playfabRequest('/Server/UpdateUserTitleDisplayName',{PlayFabId:playfabId,DisplayName:displayName.substring(0,25)});
    if (profile) {
      await playfabRequest('/Server/UpdatePlayerStatistics',{PlayFabId:playfabId,Statistics:[
        {StatisticName:'TotalScore', Value:profile.totalScore},
        {StatisticName:'TotalKills', Value:profile.totalKills},
        {StatisticName:'GamesPlayed',Value:profile.gamesPlayed},
        {StatisticName:'HighScore',  Value:profile.highScore},
        {StatisticName:'Coins',      Value:profile.coins}
      ]});
    }
    res.json({success:true,playfabId,newlyCreated,displayName:displayName||playerName});
  } catch(err) {
    console.error('PlayFab link error:',err.message);
    res.status(500).json({error:'PlayFab error: '+err.message});
  }
});

app.get('/api/playfab/leaderboard',async(req,res)=>{
  if (!PLAYFAB_TITLE_ID||!PLAYFAB_SECRET) return res.status(503).json({error:'Not configured.'});
  try {
    const r=await playfabRequest('/Server/GetLeaderboard',{StatisticName:'HighScore',StartPosition:0,MaxResultsCount:20});
    if (!r||r.code!==200) return res.status(400).json({error:r?.errorMessage||'Failed'});
    res.json(r.data.Leaderboard||[]);
  } catch(e){res.status(500).json({error:e.message});}
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`🐍 Z3N0 Snake on port ${PORT}`);
  console.log(PLAYFAB_TITLE_ID&&PLAYFAB_SECRET ? `🎮 PlayFab ENABLED (${PLAYFAB_TITLE_ID})` : `⚠️  PlayFab DISABLED`);
});
