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
const OWNER_PASSWORD   = 'Z3N0ISKING';
const ADMIN_SITE_PASSWORD = 'Z3N0ADMIN';
const PLAYFAB_TITLE_ID = '12F9AF';
const PLAYFAB_API      = `https://${PLAYFAB_TITLE_ID}.playfabapi.com`;

const MAP_SIZE         = 12000;  // Expanded from 6000
const ORB_COUNT        = 1800;   // More orbs for bigger map
const TICK_RATE        = 30;
const SNAKE_SPEED      = 2.8;
const BOOST_SPEED      = 5.2;
const SEGMENT_DISTANCE = 12;
const INITIAL_LENGTH   = 10;
const GROW_PER_ORB     = 3;

const OWNER_SKINS = [
  'rainbow_god','void_lord','galaxy_emperor','neon_death','chrome_divine',
  'z3n0_exclusive','death_god','cosmos','blood_moon','electric_god',
  'phantom_king','celestial_titan','dark_matter','solar_flare','nebula_master',
  'quantum_void','inferno_lord','crystal_deity','storm_god','abyss_walker'
];

// ============================================================
//  PLAYFAB INTEGRATION
// ============================================================
async function playfabRequest(endpoint, body, secretKey = null) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (secretKey) headers['X-SecretKey'] = secretKey;
    const res = await fetch(`${PLAYFAB_API}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error('[PlayFab] Error:', e.message);
    return null;
  }
}

async function playfabLoginOrRegister(name, customId) {
  return playfabRequest('/Client/LoginWithCustomID', {
    CustomId: customId,
    CreateAccount: true,
    TitleId: PLAYFAB_TITLE_ID,
    InfoRequestParameters: {
      GetUserData: true,
      GetUserVirtualCurrency: true,
      GetUserInventory: true
    }
  });
}

async function playfabUpdateUserData(sessionTicket, dataObj) {
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Authorization': sessionTicket };
    const res = await fetch(`${PLAYFAB_API}/Client/UpdateUserData`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ Data: dataObj })
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function playfabAddVirtualCurrency(playFabId, amount, secretKey) {
  return playfabRequest('/Server/AddUserVirtualCurrency', {
    PlayFabId: playFabId,
    VirtualCurrency: 'GD',
    Amount: amount
  }, secretKey);
}

async function playfabSubtractVirtualCurrency(playFabId, amount, secretKey) {
  return playfabRequest('/Server/SubtractUserVirtualCurrency', {
    PlayFabId: playFabId,
    VirtualCurrency: 'GD',
    Amount: amount
  }, secretKey);
}

async function playfabGetPlayerData(playFabId, secretKey) {
  return playfabRequest('/Server/GetUserData', {
    PlayFabId: playFabId,
    Keys: ['cosmetics', 'stats', 'equipped']
  }, secretKey);
}

async function playfabUpdatePlayerData(playFabId, data, secretKey) {
  const stringified = {};
  for (const key in data) stringified[key] = JSON.stringify(data[key]);
  return playfabRequest('/Server/UpdateUserData', {
    PlayFabId: playFabId,
    Data: stringified
  }, secretKey);
}

// ============================================================
//  PLAYER DATABASE (local fallback + PlayFab sync)
// ============================================================
const playerDB = {};

function getOrCreateProfile(name) {
  const key = name.toLowerCase();
  if (!playerDB[key]) {
    playerDB[key] = {
      name,
      coins: 0,
      gdCurrency: 0,
      totalScore: 0,
      totalKills: 0,
      gamesPlayed: 0,
      highScore: 0,
      unlockedCosmetics: ['title_rookie'],
      equippedTrail: null,
      equippedTitle: null,
      equippedBadge: null,
      equippedEffect: null,
      playfabId: null,
      playfabSession: null,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
  }
  playerDB[key].lastSeen = Date.now();
  return playerDB[key];
}

// ============================================================
//  MASSIVE COSMETICS CATALOG
// ============================================================
const COSMETICS = {
  // ── TRAILS (Normal) ─────────────────────────────────────
  trail_fire:           { id:'trail_fire',           type:'trail', name:'Fire Trail',           price:100,  emoji:'🔥', color:'#ff4400', rarity:'common' },
  trail_ice:            { id:'trail_ice',             type:'trail', name:'Ice Trail',             price:100,  emoji:'❄️', color:'#00ccff', rarity:'common' },
  trail_gold:           { id:'trail_gold',            type:'trail', name:'Gold Trail',            price:200,  emoji:'⭐', color:'#ffd700', rarity:'uncommon' },
  trail_rainbow:        { id:'trail_rainbow',         type:'trail', name:'Rainbow Trail',         price:500,  emoji:'🌈', color:'rainbow', rarity:'rare' },
  trail_void:           { id:'trail_void',            type:'trail', name:'Void Trail',            price:300,  emoji:'🌑', color:'#aa00ff', rarity:'uncommon' },
  trail_electric:       { id:'trail_electric',        type:'trail', name:'Electric Trail',        price:250,  emoji:'⚡', color:'#00ffff', rarity:'uncommon' },
  trail_smoke:          { id:'trail_smoke',           type:'trail', name:'Smoke Trail',           price:180,  emoji:'💨', color:'#888888', rarity:'common' },
  trail_toxic:          { id:'trail_toxic',           type:'trail', name:'Toxic Trail',           price:220,  emoji:'☣️', color:'#88ff00', rarity:'uncommon' },
  trail_blood:          { id:'trail_blood',           type:'trail', name:'Blood Trail',           price:280,  emoji:'🩸', color:'#cc0000', rarity:'uncommon' },
  trail_cosmic:         { id:'trail_cosmic',          type:'trail', name:'Cosmic Trail',          price:450,  emoji:'🌌', color:'#4444ff', rarity:'rare' },
  trail_neon:           { id:'trail_neon',            type:'trail', name:'Neon Trail',            price:350,  emoji:'💫', color:'#ff00ff', rarity:'rare' },
  trail_lava:           { id:'trail_lava',            type:'trail', name:'Lava Trail',            price:320,  emoji:'🌋', color:'#ff4400', rarity:'uncommon' },
  trail_ghost:          { id:'trail_ghost',           type:'trail', name:'Ghost Trail',           price:400,  emoji:'👻', color:'#eeeeff', rarity:'rare' },
  trail_sakura:         { id:'trail_sakura',          type:'trail', name:'Sakura Trail',          price:380,  emoji:'🌸', color:'#ffaacc', rarity:'rare' },
  trail_pixel:          { id:'trail_pixel',           type:'trail', name:'Pixel Trail',           price:280,  emoji:'🕹️', color:'#00ff00', rarity:'uncommon' },
  trail_aurora:         { id:'trail_aurora',          type:'trail', name:'Aurora Trail',          price:600,  emoji:'🌊', color:'#00ffcc', rarity:'epic' },
  trail_shadow:         { id:'trail_shadow',          type:'trail', name:'Shadow Trail',          price:550,  emoji:'🌑', color:'#330033', rarity:'epic' },
  trail_crystal:        { id:'trail_crystal',         type:'trail', name:'Crystal Trail',         price:480,  emoji:'💎', color:'#aaddff', rarity:'rare' },
  trail_solar:          { id:'trail_solar',           type:'trail', name:'Solar Trail',           price:520,  emoji:'☀️', color:'#ffcc00', rarity:'epic' },
  trail_ocean:          { id:'trail_ocean',           type:'trail', name:'Ocean Trail',           price:300,  emoji:'🌊', color:'#0066ff', rarity:'uncommon' },

  // ── TITLES (Normal) ──────────────────────────────────────
  title_rookie:         { id:'title_rookie',          type:'title', name:'Rookie',                price:0,    emoji:'🐍', text:'[ROOKIE]',         rarity:'common' },
  title_hunter:         { id:'title_hunter',          type:'title', name:'Hunter',                price:150,  emoji:'🏹', text:'[HUNTER]',         rarity:'common' },
  title_legend:         { id:'title_legend',          type:'title', name:'Legend',                price:400,  emoji:'🏆', text:'[LEGEND]',         rarity:'rare' },
  title_shadow:         { id:'title_shadow',          type:'title', name:'Shadow',                price:300,  emoji:'🌑', text:'[SHADOW]',         rarity:'uncommon' },
  title_god:            { id:'title_god',             type:'title', name:'God',                   price:999,  emoji:'⚡', text:'[GOD]',            rarity:'legendary' },
  title_predator:       { id:'title_predator',        type:'title', name:'Predator',              price:350,  emoji:'🦈', text:'[PREDATOR]',       rarity:'uncommon' },
  title_phantom:        { id:'title_phantom',         type:'title', name:'Phantom',               price:420,  emoji:'👻', text:'[PHANTOM]',        rarity:'rare' },
  title_viper:          { id:'title_viper',           type:'title', name:'Viper',                 price:200,  emoji:'🐍', text:'[VIPER]',          rarity:'common' },
  title_warlord:        { id:'title_warlord',         type:'title', name:'Warlord',               price:600,  emoji:'⚔️', text:'[WARLORD]',        rarity:'epic' },
  title_champion:       { id:'title_champion',        type:'title', name:'Champion',              price:550,  emoji:'🏅', text:'[CHAMPION]',       rarity:'epic' },
  title_reaper:         { id:'title_reaper',          type:'title', name:'Reaper',                price:700,  emoji:'💀', text:'[REAPER]',         rarity:'epic' },
  title_slayer:         { id:'title_slayer',          type:'title', name:'Slayer',                price:480,  emoji:'🗡️', text:'[SLAYER]',         rarity:'rare' },
  title_ghost:          { id:'title_ghost',           type:'title', name:'Ghost',                 price:360,  emoji:'👻', text:'[GHOST]',          rarity:'uncommon' },
  title_nexus:          { id:'title_nexus',           type:'title', name:'Nexus',                 price:800,  emoji:'🔮', text:'[NEXUS]',          rarity:'epic' },
  title_void:           { id:'title_void',            type:'title', name:'Void',                  price:850,  emoji:'🌑', text:'[VOID]',           rarity:'epic' },
  title_colossus:       { id:'title_colossus',        type:'title', name:'Colossus',              price:900,  emoji:'🗿', text:'[COLOSSUS]',       rarity:'legendary' },
  title_serpent:        { id:'title_serpent',         type:'title', name:'Serpent King',          price:750,  emoji:'🐍', text:'[SERPENT KING]',   rarity:'epic' },
  title_noob:           { id:'title_noob',            type:'title', name:'Noob',                  price:50,   emoji:'🍃', text:'[NOOB]',           rarity:'common' },
  title_tryhard:        { id:'title_tryhard',         type:'title', name:'Try-Hard',              price:280,  emoji:'😤', text:'[TRY-HARD]',       rarity:'uncommon' },
  title_menace:         { id:'title_menace',          type:'title', name:'Menace',                price:500,  emoji:'😈', text:'[MENACE]',         rarity:'rare' },

  // ── BADGES (Normal) ──────────────────────────────────────
  badge_skull:          { id:'badge_skull',           type:'badge', name:'Skull Badge',           price:200,  emoji:'💀', rarity:'common' },
  badge_star:           { id:'badge_star',            type:'badge', name:'Star Badge',            price:150,  emoji:'⭐', rarity:'common' },
  badge_dragon:         { id:'badge_dragon',          type:'badge', name:'Dragon Badge',          price:350,  emoji:'🐉', rarity:'uncommon' },
  badge_crown:          { id:'badge_crown',           type:'badge', name:'Crown Badge',           price:500,  emoji:'👑', rarity:'rare' },
  badge_fire:           { id:'badge_fire',            type:'badge', name:'Fire Badge',            price:250,  emoji:'🔥', rarity:'common' },
  badge_lightning:      { id:'badge_lightning',       type:'badge', name:'Lightning Badge',       price:280,  emoji:'⚡', rarity:'uncommon' },
  badge_moon:           { id:'badge_moon',            type:'badge', name:'Moon Badge',            price:300,  emoji:'🌙', rarity:'uncommon' },
  badge_diamond:        { id:'badge_diamond',         type:'badge', name:'Diamond Badge',         price:600,  emoji:'💎', rarity:'epic' },
  badge_toxic:          { id:'badge_toxic',           type:'badge', name:'Toxic Badge',           price:320,  emoji:'☣️', rarity:'uncommon' },
  badge_robot:          { id:'badge_robot',           type:'badge', name:'Robot Badge',           price:380,  emoji:'🤖', rarity:'rare' },
  badge_ghost:          { id:'badge_ghost',           type:'badge', name:'Ghost Badge',           price:350,  emoji:'👻', rarity:'uncommon' },
  badge_sword:          { id:'badge_sword',           type:'badge', name:'Sword Badge',           price:400,  emoji:'⚔️', rarity:'rare' },
  badge_snake:          { id:'badge_snake',           type:'badge', name:'Snake Badge',           price:250,  emoji:'🐍', rarity:'common' },
  badge_galaxy:         { id:'badge_galaxy',          type:'badge', name:'Galaxy Badge',          price:700,  emoji:'🌌', rarity:'epic' },
  badge_alien:          { id:'badge_alien',           type:'badge', name:'Alien Badge',           price:450,  emoji:'👽', rarity:'rare' },
  badge_target:         { id:'badge_target',          type:'badge', name:'Target Badge',          price:200,  emoji:'🎯', rarity:'common' },
  badge_trophy:         { id:'badge_trophy',          type:'badge', name:'Trophy Badge',          price:550,  emoji:'🏆', rarity:'rare' },
  badge_bomb:           { id:'badge_bomb',            type:'badge', name:'Bomb Badge',            price:320,  emoji:'💣', rarity:'uncommon' },
  badge_angel:          { id:'badge_angel',           type:'badge', name:'Angel Badge',           price:500,  emoji:'😇', rarity:'rare' },
  badge_devil:          { id:'badge_devil',           type:'badge', name:'Devil Badge',           price:500,  emoji:'😈', rarity:'rare' },

  // ── EFFECTS ──────────────────────────────────────────────
  effect_sparkle:       { id:'effect_sparkle',        type:'effect', name:'Sparkle Effect',       price:400,  emoji:'✨', rarity:'rare' },
  effect_aura:          { id:'effect_aura',           type:'effect', name:'Glow Aura',            price:500,  emoji:'🌟', rarity:'rare' },
  effect_electric:      { id:'effect_electric',       type:'effect', name:'Electric Pulse',       price:600,  emoji:'⚡', rarity:'epic' },
  effect_smoke:         { id:'effect_smoke',          type:'effect', name:'Dark Smoke',           price:450,  emoji:'🌫️', rarity:'rare' },
  effect_leaves:        { id:'effect_leaves',         type:'effect', name:'Leaf Swirl',           price:350,  emoji:'🍃', rarity:'uncommon' },
  effect_bubbles:       { id:'effect_bubbles',        type:'effect', name:'Bubble Pop',           price:300,  emoji:'🫧', rarity:'uncommon' },
  effect_fire_ring:     { id:'effect_fire_ring',      type:'effect', name:'Fire Ring',            price:700,  emoji:'🔥', rarity:'epic' },
  effect_ice_crystal:   { id:'effect_ice_crystal',    type:'effect', name:'Ice Crystal',          price:650,  emoji:'❄️', rarity:'epic' },

  // ── OWNER EXCLUSIVE ──────────────────────────────────────
  owner_aura:           { id:'owner_aura',            type:'owner', name:'Z3N0 Divine Aura',      price:-1,   emoji:'✨', ownerOnly:true, rarity:'god' },
  owner_trail:          { id:'owner_trail',           type:'owner', name:'Z3N0 Royal Trail',      price:-1,   emoji:'👑', ownerOnly:true, rarity:'god' },
  owner_title:          { id:'owner_title',           type:'owner', name:'[Z3N0] Title',          price:-1,   emoji:'👑', ownerOnly:true, text:'[Z3N0]', rarity:'god' },
  owner_explode:        { id:'owner_explode',         type:'owner', name:'God Death Explosion',   price:-1,   emoji:'💥', ownerOnly:true, rarity:'god' },
  owner_rainbow_aura:   { id:'owner_rainbow_aura',    type:'owner', name:'Rainbow God Aura',      price:-1,   emoji:'🌈', ownerOnly:true, rarity:'god' },
  owner_galaxy_trail:   { id:'owner_galaxy_trail',    type:'owner', name:'Galaxy Destroyer Trail',price:-1,   emoji:'🌌', ownerOnly:true, rarity:'god', color:'galaxy' },
  owner_phantom_step:   { id:'owner_phantom_step',    type:'owner', name:'Phantom Step Trail',    price:-1,   emoji:'👻', ownerOnly:true, rarity:'god' },
  owner_void_rift:      { id:'owner_void_rift',       type:'owner', name:'Void Rift Aura',        price:-1,   emoji:'🌑', ownerOnly:true, rarity:'god' },
  owner_crown_burst:    { id:'owner_crown_burst',     type:'owner', name:'Crown Burst Effect',    price:-1,   emoji:'💫', ownerOnly:true, rarity:'god' },
  owner_celestial:      { id:'owner_celestial',       type:'owner', name:'Celestial Wings',       price:-1,   emoji:'🪽', ownerOnly:true, rarity:'god' },
  owner_blood_moon:     { id:'owner_blood_moon',      type:'owner', name:'Blood Moon Trail',      price:-1,   emoji:'🔴', ownerOnly:true, rarity:'god', color:'#cc0022' },
  owner_solar_god:      { id:'owner_solar_god',       type:'owner', name:'Solar God Effect',      price:-1,   emoji:'☀️', ownerOnly:true, rarity:'god' },
  owner_storm_lord:     { id:'owner_storm_lord',      type:'owner', name:'Storm Lord Aura',       price:-1,   emoji:'⛈️', ownerOnly:true, rarity:'god' },
  owner_z3n0_badge:     { id:'owner_z3n0_badge',      type:'owner', name:'Z3N0 Exclusive Badge',  price:-1,   emoji:'🛡️', ownerOnly:true, rarity:'god' },
  owner_neon_god:       { id:'owner_neon_god',        type:'owner', name:'Neon God Trail',        price:-1,   emoji:'🔆', ownerOnly:true, rarity:'god', color:'#ff00ff' },
  owner_title_supreme:  { id:'owner_title_supreme',   type:'owner', name:'[SUPREME] Title',       price:-1,   emoji:'🔱', ownerOnly:true, text:'[SUPREME]', rarity:'god' },
  owner_title_creator:  { id:'owner_title_creator',   type:'owner', name:'[CREATOR] Title',       price:-1,   emoji:'⚒️', ownerOnly:true, text:'[CREATOR]', rarity:'god' },
  owner_title_immortal: { id:'owner_title_immortal',  type:'owner', name:'[IMMORTAL] Title',      price:-1,   emoji:'♾️', ownerOnly:true, text:'[IMMORTAL]', rarity:'god' },
  owner_title_diety:    { id:'owner_title_diety',     type:'owner', name:'[DEITY] Title',         price:-1,   emoji:'🌟', ownerOnly:true, text:'[DEITY]', rarity:'god' },
  owner_title_godking:  { id:'owner_title_godking',   type:'owner', name:'[GOD-KING] Title',      price:-1,   emoji:'👑', ownerOnly:true, text:'[GOD-KING]', rarity:'god' },
  owner_death_god_trail:{ id:'owner_death_god_trail', type:'owner', name:'Death God Trail',       price:-1,   emoji:'💀', ownerOnly:true, rarity:'god', color:'#ff0000' },
  owner_cosmos_trail:   { id:'owner_cosmos_trail',    type:'owner', name:'Cosmos Trail',          price:-1,   emoji:'🌠', ownerOnly:true, rarity:'god', color:'#0000ff' },
  owner_inverse:        { id:'owner_inverse',         type:'owner', name:'Reality Inverter Aura', price:-1,   emoji:'🔄', ownerOnly:true, rarity:'god' },
  owner_dimension_rip:  { id:'owner_dimension_rip',   type:'owner', name:'Dimension Rip Effect',  price:-1,   emoji:'🌀', ownerOnly:true, rarity:'god' },
  owner_dark_matter:    { id:'owner_dark_matter',     type:'owner', name:'Dark Matter Aura',      price:-1,   emoji:'🕳️', ownerOnly:true, rarity:'god' },
  owner_star_forge:     { id:'owner_star_forge',      type:'owner', name:'Star Forge Trail',      price:-1,   emoji:'⭐', ownerOnly:true, rarity:'god', color:'#ffff00' },
  owner_alpha_badge:    { id:'owner_alpha_badge',     type:'owner', name:'Alpha Serpent Badge',   price:-1,   emoji:'🐍', ownerOnly:true, rarity:'god' },
  owner_omega_badge:    { id:'owner_omega_badge',     type:'owner', name:'Omega Badge',           price:-1,   emoji:'Ω', ownerOnly:true, rarity:'god' },
  owner_divine_glow:    { id:'owner_divine_glow',     type:'owner', name:'Divine Glow Effect',    price:-1,   emoji:'🌟', ownerOnly:true, rarity:'god' },
  owner_serpent_god:    { id:'owner_serpent_god',     type:'owner', name:'Serpent God Trail',     price:-1,   emoji:'🐲', ownerOnly:true, rarity:'god', color:'#00ff00' },
  owner_time_warp:      { id:'owner_time_warp',       type:'owner', name:'Time Warp Aura',        price:-1,   emoji:'⏰', ownerOnly:true, rarity:'god' },
  owner_crown_god:      { id:'owner_crown_god',       type:'owner', name:'Crown of Gods',         price:-1,   emoji:'👑', ownerOnly:true, rarity:'god' },
  owner_inferno_deity:  { id:'owner_inferno_deity',   type:'owner', name:'Inferno Deity Trail',   price:-1,   emoji:'🔥', ownerOnly:true, rarity:'god', color:'#ff6600' },
  owner_lightning_god:  { id:'owner_lightning_god',   type:'owner', name:'Lightning God Aura',   price:-1,   emoji:'🌩️', ownerOnly:true, rarity:'god' },
  owner_prism:          { id:'owner_prism',           type:'owner', name:'Prism Overload Trail',  price:-1,   emoji:'🔮', ownerOnly:true, rarity:'god', color:'prism' },
};

// ============================================================
//  PLAYFAB CATALOG JSON (for reference / server import)
// ============================================================
const PLAYFAB_CATALOG = {
  CatalogVersion: 'Z3N0_Cosmetics_v1',
  Catalog: [
    ...Object.values(COSMETICS).filter(c => !c.ownerOnly && c.price >= 0).map(c => ({
      ItemId: c.id,
      DisplayName: c.name,
      Description: `${c.emoji} ${c.name} - ${c.type} cosmetic`,
      VirtualCurrencyPrices: { GD: c.price },
      Tags: [c.type, c.rarity || 'common'],
      CustomData: JSON.stringify({ emoji: c.emoji, type: c.type, color: c.color || null, text: c.text || null, rarity: c.rarity })
    }))
  ]
};

// ============================================================
//  GAME STATE
// ============================================================
let players = {};
let orbs    = {};
let activeEvent  = null;
let leaderboard  = [];
// Zone system — multiple named zones on the expanded map
const ZONES = [
  { id:'center',    name:'The Nexus',     x:5000, y:5000, radius:2000, orbBonus:1.5, color:'#00ff8c' },
  { id:'north',     name:'Frost Wastes',  x:6000, y:1000, radius:1800, speedMult:1.2, color:'#00ccff' },
  { id:'south',     name:'Lava Fields',   x:6000, y:11000,radius:1800, orbBonus:2.0, color:'#ff4400' },
  { id:'west',      name:'Shadow Forest', x:1000, y:6000, radius:1500, color:'#330033' },
  { id:'east',      name:'Storm Plains',  x:11000,y:6000, radius:1500, speedMult:1.1, color:'#aa44ff' },
  { id:'void_zone', name:'The Void',      x:1500, y:1500, radius:1200, speedMult:1.3, orbBonus:3.0, color:'#000033' },
  { id:'gold_zone', name:'Gold Rush',     x:10500,y:10500,radius:1200, orbBonus:4.0, color:'#ffd700' },
];

// ── ORB TYPES ────────────────────────────────────────────────
const ORB_TYPES = [
  { weight:60, size:[4,8],   value:1, colors:['#ff2244','#ff6600','#ffdd00','#44ff22','#00ccff','#aa44ff','#ff44aa'] },
  { weight:25, size:[8,14],  value:3, colors:['#ff8800','#00ffcc','#ff00ff','#8800ff','#00ff88'] },
  { weight:10, size:[14,22], value:8, colors:['#ffd700','#ffffff','#00ffff'] },
  { weight:5,  size:[22,32], value:20,colors:['#ffd700','#ffd700'] }, // Golden super-orb
];

function pickOrbType() {
  const r = Math.random()*100;
  let acc = 0;
  for (const t of ORB_TYPES) { acc += t.weight; if (r < acc) return t; }
  return ORB_TYPES[0];
}

function createOrb(id, zone = null) {
  const type = pickOrbType();
  const colors = type.colors;
  const px = zone
    ? zone.x + (Math.random()-0.5)*zone.radius*2
    : Math.random()*MAP_SIZE;
  const py = zone
    ? zone.y + (Math.random()-0.5)*zone.radius*2
    : Math.random()*MAP_SIZE;
  return {
    id: id || uuidv4(),
    x: Math.max(100, Math.min(MAP_SIZE-100, px)),
    y: Math.max(100, Math.min(MAP_SIZE-100, py)),
    color: colors[Math.floor(Math.random()*colors.length)],
    size: type.size[0] + Math.random()*(type.size[1]-type.size[0]),
    value: type.value,
    tier: ORB_TYPES.indexOf(type)
  };
}

function initOrbs() {
  // Distribute orbs with more density in zones
  for (let i = 0; i < ORB_COUNT * 0.7; i++) {
    const orb = createOrb();
    orbs[orb.id] = orb;
  }
  for (const zone of ZONES) {
    const zoneOrbs = Math.floor(ORB_COUNT * 0.3 / ZONES.length);
    for (let i = 0; i < zoneOrbs; i++) {
      const orb = createOrb(null, zone);
      orbs[orb.id] = orb;
    }
  }
}
initOrbs();

function createSegments(x, y, length) {
  const segs = [];
  for (let i = 0; i < length; i++) segs.push({ x: x - i*SEGMENT_DISTANCE, y });
  return segs;
}

function dist(a, b) {
  const dx = a.x-b.x, dy = a.y-b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

function getZoneAt(x, y) {
  for (const zone of ZONES) {
    if (dist({x,y}, zone) < zone.radius) return zone;
  }
  return null;
}

// ============================================================
//  COLLISION
// ============================================================
function checkCollisions() {
  const pArr = Object.values(players);
  for (const p of pArr) {
    if (p.dead) continue;
    const head = p.segments[0];

    // Wall check
    if (head.x < 0 || head.x > MAP_SIZE || head.y < 0 || head.y > MAP_SIZE) {
      killPlayer(p, null); continue;
    }

    // Zone bonus
    const zone = getZoneAt(head.x, head.y);
    p.currentZone = zone ? zone.id : null;

    // Orb eating
    for (const oid in orbs) {
      const orb = orbs[oid];
      if (dist(head, orb) < p.width + orb.size) {
        const bonus = zone?.orbBonus || 1;
        const gained = Math.ceil(orb.value * bonus);
        p.growBuffer += GROW_PER_ORB * gained;
        p.score      += gained;
        p.sessionCoins += gained;
        delete orbs[oid];
        const newOrb = createOrb();
        orbs[newOrb.id] = newOrb;
        io.emit('orbEaten', { oid, newOrb });
        break;
      }
    }

    // Snake-vs-snake
    for (const other of pArr) {
      if (other.id === p.id || other.dead) continue;
      for (let si = 3; si < other.segments.length; si++) {
        if (dist(head, other.segments[si]) < p.width + other.width - 4) {
          killPlayer(p, other); break;
        }
      }
      if (p.segments.length <= other.segments.length) {
        if (dist(head, other.segments[0]) < p.width + other.width) {
          killPlayer(p, other); break;
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
  profile.coins      += player.sessionCoins;
  profile.gamesPlayed++;
  if (player.score > profile.highScore) profile.highScore = player.score;

  // PlayFab sync on death
  if (profile.playfabId && process.env.PLAYFAB_SECRET) {
    playfabAddVirtualCurrency(profile.playfabId, player.sessionCoins, process.env.PLAYFAB_SECRET).catch(()=>{});
    playfabUpdatePlayerData(profile.playfabId, {
      stats: { totalScore: profile.totalScore, totalKills: profile.totalKills, gamesPlayed: profile.gamesPlayed, highScore: profile.highScore },
      cosmetics: profile.unlockedCosmetics,
      equipped: { trail: profile.equippedTrail, title: profile.equippedTitle, badge: profile.equippedBadge }
    }, process.env.PLAYFAB_SECRET).catch(()=>{});
  }

  const dropCount = Math.min(Math.floor(player.segments.length/2), 120);
  const droppedOrbs = [];
  for (let i = 0; i < dropCount; i++) {
    const seg = player.segments[Math.floor(Math.random()*player.segments.length)];
    const orb = createOrb();
    orb.x = seg.x + (Math.random()-0.5)*80;
    orb.y = seg.y + (Math.random()-0.5)*80;
    orb.size = 12; orb.value = 3; orb.tier = 2;
    orbs[orb.id] = orb;
    droppedOrbs.push(orb);
  }

  io.emit('playerDied', { id:player.id, killerName:killer?killer.name:'the void', droppedOrbs });

  if (killer) {
    killer.score       += Math.floor(player.score * 0.3);
    killer.sessionCoins += Math.floor(player.score * 0.3);
    killer.kills        = (killer.kills||0) + 1;
    getOrCreateProfile(killer.name).totalKills++;
    io.to(killer.socketId).emit('killConfirmed', { victimName:player.name });
  }

  io.to(player.socketId).emit('youDied', {
    killerName: killer ? killer.name : 'the wall',
    coinsEarned: player.sessionCoins,
    score: player.score,
    length: player.segments.length
  });

  setTimeout(() => { delete players[player.id]; io.emit('playerLeft', player.id); }, 1000);
}

// ============================================================
//  GAME TICK
// ============================================================
function gameTick() {
  for (const pid in players) {
    const p = players[pid];
    if (p.dead || !p.alive) continue;

    const zone = getZoneAt(p.segments[0].x, p.segments[0].y);
    const zoneMult = zone?.speedMult || 1;
    const baseSpeed = p.speed || SNAKE_SPEED;
    const speed = p.boosting ? BOOST_SPEED * zoneMult : baseSpeed * zoneMult;

    const head = p.segments[0];
    p.segments.unshift({ x: head.x + Math.cos(p.angle)*speed, y: head.y + Math.sin(p.angle)*speed });

    if (p.growBuffer > 0) p.growBuffer--;
    else p.segments.pop();

    p.width = Math.max(6, Math.min(28, 6 + p.segments.length*0.02));

    // Boost drains tail
    if (p.boosting && p.segments.length > INITIAL_LENGTH*SEGMENT_DISTANCE) {
      if (Math.random() < 0.3) {
        const tail = p.segments[p.segments.length-1];
        const orb = createOrb();
        orb.x = tail.x; orb.y = tail.y; orb.size = 8; orb.value = 1; orb.tier = 0;
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
    .sort((a,b) => b.segments.length - a.segments.length)
    .slice(0, 10)
    .map(p => ({
      name:p.name, length:p.segments.length, score:p.score,
      skin:p.skin, isOwner:p.isOwner, id:p.id,
      equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge,
      currentZone:p.currentZone||null
    }));
}

setInterval(gameTick, TICK_RATE);

// State broadcast with segment culling
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  const state = {};
  for (const pid in players) {
    const p = players[pid];
    if (p.dead) continue;
    let segs = p.segments;
    if (segs.length > 250) segs = segs.filter((_,i) => i < 20 || i%2===0);
    state[pid] = {
      segments:segs, angle:p.angle, skin:p.skin, name:p.name,
      width:p.width, boosting:p.boosting, isOwner:p.isOwner,
      grantedSkin:p.grantedSkin, effect:p.effect||null,
      equippedTrail:p.equippedTrail||null,
      equippedTitle:p.equippedTitle||null,
      equippedBadge:p.equippedBadge||null,
      equippedEffect:p.equippedEffect||null,
      sessionCoins:p.sessionCoins,
      currentZone:p.currentZone||null,
      kills:p.kills||0
    };
  }
  io.emit('gameState', { players:state, leaderboard, activeEvent, zones:ZONES });
}, TICK_RATE);

// ============================================================
//  SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {

  socket.on('joinGame', async ({ name, skin, password, playfabId, playfabSession }) => {
    const isOwner   = password === OWNER_PASSWORD;
    const actualSkin = isOwner ? skin : (OWNER_SKINS.includes(skin) ? 'classic' : skin);
    const startX = 500 + Math.random()*(MAP_SIZE-1000);
    const startY = 500 + Math.random()*(MAP_SIZE-1000);
    const profile = getOrCreateProfile(name);

    // PlayFab sync if provided
    if (playfabId && playfabSession) {
      profile.playfabId      = playfabId;
      profile.playfabSession = playfabSession;
    }

    // Try to get PlayFab GD balance
    let gdBalance = profile.gdCurrency || 0;
    if (profile.playfabId && process.env.PLAYFAB_SECRET) {
      try {
        const pfData = await playfabGetPlayerData(profile.playfabId, process.env.PLAYFAB_SECRET);
        if (pfData?.data?.Data?.cosmetics) {
          const pfCosmetics = JSON.parse(pfData.data.Data.cosmetics.Value || '[]');
          for (const c of pfCosmetics) {
            if (!profile.unlockedCosmetics.includes(c)) profile.unlockedCosmetics.push(c);
          }
        }
      } catch(e) {}
    }

    const player = {
      id: uuidv4(), socketId: socket.id,
      name: name||'Snake', skin: actualSkin, grantedSkin: null,
      segments: createSegments(startX, startY, INITIAL_LENGTH),
      angle: 0, speed: SNAKE_SPEED, boosting: false,
      growBuffer: 0, score: 0, sessionCoins: 0, kills: 0,
      width: 8, dead: false, alive: true, isOwner, effect: null,
      equippedTrail:  profile.equippedTrail,
      equippedTitle:  isOwner ? '[Z3N0]'       : profile.equippedTitle,
      equippedBadge:  isOwner ? '👑'            : profile.equippedBadge,
      equippedEffect: profile.equippedEffect || null,
      unlockedCosmetics: isOwner ? Object.keys(COSMETICS) : [...profile.unlockedCosmetics],
      currentZone: null
    };

    players[player.id] = player;
    socket.playerId    = player.id;

    socket.emit('joined', {
      playerId: player.id, isOwner, mapSize: MAP_SIZE,
      orbs: Object.values(orbs),
      zones: ZONES,
      profile: {
        coins:            profile.coins,
        gdCurrency:       gdBalance,
        totalScore:       profile.totalScore,
        totalKills:       profile.totalKills,
        gamesPlayed:      profile.gamesPlayed,
        highScore:        profile.highScore,
        unlockedCosmetics: player.unlockedCosmetics,
        equippedTrail:    player.equippedTrail,
        equippedTitle:    player.equippedTitle,
        equippedBadge:    player.equippedBadge,
        equippedEffect:   player.equippedEffect
      },
      cosmeticsCatalog: COSMETICS
    });

    io.emit('playerJoined', { id:player.id, name:player.name, isOwner });
  });

  socket.on('input', ({ angle, boosting }) => {
    const p = players[socket.playerId];
    if (!p || p.dead) return;
    p.angle = angle; p.boosting = boosting;
  });

  // ── COSMETICS ─────────────────────────────────────────────
  socket.on('buyCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId];
    if (!p) return;
    const cosmetic = COSMETICS[cosmeticId];
    if (!cosmetic || cosmetic.ownerOnly || cosmetic.price < 0) { socket.emit('cosmeticError','Not available.'); return; }
    const profile = getOrCreateProfile(p.name);
    if (profile.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError','Already owned!'); return; }
    const total = profile.coins + (p.sessionCoins || 0);
    if (total < cosmetic.price) { socket.emit('cosmeticError',`Need ${cosmetic.price} coins (you have ${total})`); return; }

    // Deduct from session first, then banked
    let toPay = cosmetic.price;
    if (p.sessionCoins >= toPay) { p.sessionCoins -= toPay; }
    else { toPay -= p.sessionCoins; p.sessionCoins = 0; profile.coins -= toPay; }

    profile.unlockedCosmetics.push(cosmeticId);
    p.unlockedCosmetics.push(cosmeticId);

    // PlayFab sync
    if (profile.playfabId && process.env.PLAYFAB_SECRET) {
      playfabUpdatePlayerData(profile.playfabId,
        { cosmetics: profile.unlockedCosmetics },
        process.env.PLAYFAB_SECRET).catch(()=>{});
    }

    socket.emit('cosmeticBought', { cosmeticId, newCoinBalance:profile.coins, unlockedCosmetics:profile.unlockedCosmetics });
  });

  socket.on('equipCosmetic', ({ cosmeticId }) => {
    const p = players[socket.playerId];
    if (!p) return;
    const cosmetic = COSMETICS[cosmeticId];
    if (!cosmetic) return;
    if (!p.isOwner && !p.unlockedCosmetics.includes(cosmeticId)) { socket.emit('cosmeticError','You don\'t own this!'); return; }
    const profile = getOrCreateProfile(p.name);
    const t = cosmetic.type;
    if (t==='trail'||t==='owner') { p.equippedTrail=cosmeticId; profile.equippedTrail=cosmeticId; }
    else if (t==='title') { if (cosmetic.text) { p.equippedTitle=cosmetic.text; profile.equippedTitle=cosmetic.text; } }
    else if (t==='badge') { p.equippedBadge=cosmetic.emoji; profile.equippedBadge=cosmetic.emoji; }
    else if (t==='effect') { p.equippedEffect=cosmeticId; profile.equippedEffect=cosmeticId; }
    socket.emit('cosmeticEquipped', { cosmeticId, equippedTrail:p.equippedTrail, equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge, equippedEffect:p.equippedEffect });
  });

  socket.on('unequipCosmetic', ({ slot }) => {
    const p = players[socket.playerId];
    if (!p) return;
    const profile = getOrCreateProfile(p.name);
    if (slot==='trail')  { p.equippedTrail=null;  profile.equippedTrail=null;  }
    if (slot==='title')  { p.equippedTitle=null;  profile.equippedTitle=null;  }
    if (slot==='badge')  { p.equippedBadge=null;  profile.equippedBadge=null;  }
    if (slot==='effect') { p.equippedEffect=null; profile.equippedEffect=null; }
    socket.emit('cosmeticEquipped', { cosmeticId:null, equippedTrail:p.equippedTrail, equippedTitle:p.equippedTitle, equippedBadge:p.equippedBadge, equippedEffect:p.equippedEffect });
  });

  // ── OWNER ACTIONS ─────────────────────────────────────────
  socket.on('ownerAction', ({ action, targetId, value, password }) => {
    if (password !== OWNER_PASSWORD) { socket.emit('ownerError','Invalid password.'); return; }
    const target = targetId ? Object.values(players).find(p => p.id === targetId) : null;

    switch(action) {
      case 'kick':
        if (target) {
          io.to(target.socketId).emit('kicked', { reason:value||'Kicked by Z3N0.' });
          killPlayer(target, null);
          setTimeout(()=>{ const ts=io.sockets.sockets.get(target.socketId); if(ts) ts.disconnect(true); },500);
          socket.emit('ownerSuccess',`Kicked ${target.name}`);
        } break;
      case 'instaKill':
        if (target) { killPlayer(target,null); io.to(target.socketId).emit('systemMessage','☠️ Eliminated by Z3N0'); socket.emit('ownerSuccess',`Killed ${target.name}`); } break;
      case 'giveSkin':
        if (target) { target.skin=value; target.grantedSkin=value; io.to(target.socketId).emit('skinGranted',{skin:value}); socket.emit('ownerSuccess',`Gave ${value} skin to ${target.name}`); } break;
      case 'giveSize':
        if (target) {
          const amount=parseInt(value)||50;
          const tail=target.segments[target.segments.length-1];
          for(let i=0;i<amount*SEGMENT_DISTANCE;i++) target.segments.push({x:tail.x,y:tail.y});
          target.score+=amount*10;
          io.to(target.socketId).emit('systemMessage',`📏 Z3N0 granted you +${amount} size!`);
          socket.emit('ownerSuccess',`Gave ${amount} size to ${target.name}`);
        } break;
      case 'giveCoins':
        if (target) {
          const amount=parseInt(value)||100;
          const profile=getOrCreateProfile(target.name);
          profile.coins+=amount;
          io.to(target.socketId).emit('coinsGranted',{amount,newBalance:profile.coins});
          io.to(target.socketId).emit('systemMessage',`💰 Z3N0 granted you +${amount} coins!`);
          socket.emit('ownerSuccess',`Gave ${amount} coins to ${target.name}`);
        } break;
      case 'giveGD':
        if (target) {
          const amount=parseInt(value)||100;
          const profile=getOrCreateProfile(target.name);
          profile.gdCurrency=(profile.gdCurrency||0)+amount;
          if (profile.playfabId && process.env.PLAYFAB_SECRET) {
            playfabAddVirtualCurrency(profile.playfabId, amount, process.env.PLAYFAB_SECRET).catch(()=>{});
          }
          io.to(target.socketId).emit('gdGranted',{amount,newBalance:profile.gdCurrency});
          io.to(target.socketId).emit('systemMessage',`💎 Z3N0 granted you +${amount} GD!`);
          socket.emit('ownerSuccess',`Gave ${amount} GD to ${target.name}`);
        } break;
      case 'giveCosmetic':
        if (target) {
          const profile=getOrCreateProfile(target.name);
          if(!profile.unlockedCosmetics.includes(value)) profile.unlockedCosmetics.push(value);
          if(!target.unlockedCosmetics.includes(value)) target.unlockedCosmetics.push(value);
          io.to(target.socketId).emit('cosmeticGranted',{cosmeticId:value,unlockedCosmetics:profile.unlockedCosmetics});
          io.to(target.socketId).emit('systemMessage',`🎨 Z3N0 granted you: ${COSMETICS[value]?.name||value}!`);
          socket.emit('ownerSuccess',`Gave cosmetic to ${target.name}`);
        } break;
      case 'teleport':
        if (target) {
          const x = parseInt((value||'').split(',')[0]) || 6000;
          const y = parseInt((value||'').split(',')[1]) || 6000;
          target.segments = createSegments(x, y, Math.max(INITIAL_LENGTH, Math.floor(target.segments.length/SEGMENT_DISTANCE)));
          io.to(target.socketId).emit('systemMessage','🌀 Z3N0 teleported you!');
          socket.emit('ownerSuccess',`Teleported ${target.name}`);
        } break;
      case 'freeze':
        if (target) { target.speed=0; setTimeout(()=>{ if(players[target.id]) target.speed=SNAKE_SPEED; },parseInt(value)*1000||5000); io.to(target.socketId).emit('systemMessage',`❄️ Z3N0 froze you for ${parseInt(value)||5}s!`); socket.emit('ownerSuccess',`Froze ${target.name}`); } break;
      case 'swapSize': {
        const p1=Object.values(players).find(p=>p.id===targetId);
        const p2=Object.values(players).find(p=>p.id===value);
        if(p1&&p2){[p1.segments,p2.segments]=[p2.segments,p1.segments];[p1.score,p2.score]=[p2.score,p1.score];io.to(p1.socketId).emit('systemMessage','🔄 Z3N0 swapped your size!');io.to(p2.socketId).emit('systemMessage','🔄 Z3N0 swapped your size!');socket.emit('ownerSuccess',`Swapped ${p1.name} ↔ ${p2.name}`);}break;
      }
      case 'startEvent':
        activeEvent={id:uuidv4(),type:value,name:getEventName(value),startedAt:Date.now(),duration:60000};
        applyEvent(activeEvent);
        io.emit('liveEvent',activeEvent);
        socket.emit('ownerSuccess',`Started event: ${activeEvent.name}`);
        setTimeout(()=>{activeEvent=null;resetEvent();io.emit('eventEnded');},60000);
        break;
      case 'endEvent': activeEvent=null;resetEvent();io.emit('eventEnded');socket.emit('ownerSuccess','Event ended.');break;
      case 'broadcast': io.emit('ownerBroadcast',{message:value});socket.emit('ownerSuccess','Broadcast sent!');break;
      case 'massKill':
        Object.values(players).forEach(p=>{ if(!p.isOwner&&!p.dead) killPlayer(p,null); });
        io.emit('ownerBroadcast',{message:'☠️ Z3N0 has purged the realm!'});
        socket.emit('ownerSuccess','Mass kill executed.');break;
      case 'getPlayers':
        socket.emit('playerList', Object.values(players).filter(p=>!p.dead).map(p=>{
          const pr=getOrCreateProfile(p.name);
          return {id:p.id,name:p.name,skin:p.skin,score:p.score,length:p.segments.length,isOwner:p.isOwner,
            coins:pr.coins,sessionCoins:p.sessionCoins,gdCurrency:pr.gdCurrency||0,
            unlockedCosmetics:pr.unlockedCosmetics,
            equippedTrail:p.equippedTrail,equippedTitle:p.equippedTitle,equippedBadge:p.equippedBadge,
            kills:p.kills||0,zone:p.currentZone};
        }));
        break;
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.playerId];
    if (p) {
      const profile = getOrCreateProfile(p.name);
      profile.coins += p.sessionCoins;
      p.sessionCoins = 0;
      killPlayer(p, null);
      setTimeout(()=>{ delete players[socket.playerId]; io.emit('playerLeft',socket.playerId); },500);
    }
  });
});

// ============================================================
//  EVENTS
// ============================================================
function getEventName(type) {
  return {
    speedBoost:'⚡ HYPERSPEED FRENZY', orbFrenzy:'🌟 ORB OVERLOAD',
    shrinkAll:'💀 DEATH SHRINK',       growAll:'🐍 TITAN RISE',
    darkness:'🌑 BLACKOUT',            rainbow:'🌈 RAINBOW CHAOS',
    goldRush:'💰 GOLD RUSH',           deathmatch:'☠️ DEATHMATCH',
    orbStorm:'🌪️ ORB STORM',          inversed:'🔄 GRAVITY FLIP',
  }[type] || type;
}

function applyEvent(event) {
  const pArr = Object.values(players);
  if (event.type==='speedBoost') pArr.forEach(p=>p.speed=SNAKE_SPEED*2);
  if (event.type==='orbFrenzy') {
    for(let i=0;i<600;i++){const o=createOrb();orbs[o.id]=o;}
    io.emit('orbFrenzy',Object.values(orbs));
  }
  if (event.type==='shrinkAll') pArr.forEach(p=>{ if(!p.isOwner) p.segments=p.segments.slice(0,Math.max(INITIAL_LENGTH*SEGMENT_DISTANCE,Math.floor(p.segments.length/2)));});
  if (event.type==='growAll') pArr.forEach(p=>{const t=p.segments[p.segments.length-1];for(let i=0;i<150*SEGMENT_DISTANCE;i++) p.segments.push({x:t.x,y:t.y});});
  if (event.type==='goldRush') {
    // Spawn 200 gold orbs
    for(let i=0;i<200;i++){const o=createOrb();o.color='#ffd700';o.size=20;o.value=15;o.tier=3;orbs[o.id]=o;}
    io.emit('orbFrenzy',Object.values(orbs));
  }
  if (event.type==='orbStorm') {
    for(let i=0;i<800;i++){const o=createOrb();orbs[o.id]=o;}
    io.emit('orbFrenzy',Object.values(orbs));
  }
}

function resetEvent() {
  Object.values(players).forEach(p=>p.speed=SNAKE_SPEED);
}

// ============================================================
//  HTTP API
// ============================================================
app.get('/api/leaderboard', (req,res) => res.json(leaderboard));
app.get('/api/stats', (req,res) => res.json({
  players:Object.keys(players).length,
  orbs:Object.keys(orbs).length,
  activeEvent:activeEvent?activeEvent.name:null,
  mapSize:MAP_SIZE,
  zones:ZONES.length
}));
app.get('/api/zones', (req,res) => res.json(ZONES));
app.get('/api/catalog', (req,res) => res.json(PLAYFAB_CATALOG));

const adminAuth = (req,res,next) => {
  if (req.headers['x-admin-password']===ADMIN_SITE_PASSWORD) return next();
  res.status(401).json({error:'Unauthorized'});
};

app.post('/api/admin/auth', (req,res) => res.json({success:req.body.password===ADMIN_SITE_PASSWORD}));

app.get('/api/admin/players', adminAuth, (req,res) => {
  const liveByName={};
  Object.values(players).forEach(p=>{liveByName[p.name.toLowerCase()]=p;});
  res.json(Object.values(playerDB).map(profile=>{
    const live=liveByName[profile.name.toLowerCase()];
    return {
      name:profile.name, online:!!live,
      coins:profile.coins+(live?live.sessionCoins:0),
      gdCurrency:profile.gdCurrency||0,
      totalScore:profile.totalScore+(live?live.score:0),
      totalKills:profile.totalKills+(live?live.kills||0:0),
      gamesPlayed:profile.gamesPlayed, highScore:profile.highScore,
      unlockedCosmetics:profile.unlockedCosmetics,
      playfabId:profile.playfabId||null,
      firstSeen:profile.firstSeen, lastSeen:profile.lastSeen
    };
  }));
});

app.get('/api/admin/cosmetics', adminAuth, (req,res) => res.json(COSMETICS));

app.post('/api/admin/giveCoins', adminAuth, (req,res) => {
  const {name,amount}=req.body;
  const profile=playerDB[name.toLowerCase()];
  if(!profile) return res.status(404).json({error:'Player not found'});
  profile.coins+=parseInt(amount)||0;
  const live=Object.values(players).find(p=>p.name.toLowerCase()===name.toLowerCase());
  if(live){io.to(live.socketId).emit('coinsGranted',{amount,newBalance:profile.coins});io.to(live.socketId).emit('systemMessage',`💰 Admin granted you +${amount} coins!`);}
  res.json({success:true,newBalance:profile.coins});
});

app.post('/api/admin/giveCosmetic', adminAuth, (req,res) => {
  const {name,cosmeticId}=req.body;
  const profile=playerDB[name.toLowerCase()];
  if(!profile) return res.status(404).json({error:'Player not found'});
  if(!profile.unlockedCosmetics.includes(cosmeticId)) profile.unlockedCosmetics.push(cosmeticId);
  const live=Object.values(players).find(p=>p.name.toLowerCase()===name.toLowerCase());
  if(live){if(!live.unlockedCosmetics.includes(cosmeticId)) live.unlockedCosmetics.push(cosmeticId);io.to(live.socketId).emit('cosmeticGranted',{cosmeticId,unlockedCosmetics:profile.unlockedCosmetics});io.to(live.socketId).emit('systemMessage',`🎨 Admin granted: ${COSMETICS[cosmeticId]?.name||cosmeticId}!`);}
  res.json({success:true});
});

// PlayFab proxy endpoint
app.post('/api/playfab/login', async (req,res) => {
  const { name, customId } = req.body;
  if (!customId) return res.status(400).json({error:'Missing customId'});
  const result = await playfabLoginOrRegister(name, customId);
  res.json(result || {error:'PlayFab unavailable'});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐍 Z3N0 Slither Server on port ${PORT}`);
  console.log(`🗺️  Map size: ${MAP_SIZE}x${MAP_SIZE} (expanded)`);
  console.log(`🎮 PlayFab Title: ${PLAYFAB_TITLE_ID}`);
  console.log(`👑 Owner password: ${OWNER_PASSWORD}`);
  console.log(`🔐 Admin password: ${ADMIN_SITE_PASSWORD}`);
  console.log(`💎 Cosmetics loaded: ${Object.keys(COSMETICS).length}`);
  console.log(`🌍 Zones: ${ZONES.map(z=>z.name).join(', ')}`);
});
