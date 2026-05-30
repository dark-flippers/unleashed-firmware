#!/usr/bin/env node
"use strict";

/* =====================================================================
   GAUNTLET — endless Pokémon draft battler, terminal edition
   Zero dependencies. Node 18+. All data live from pokeapi.co.

   Designed to be played inside a Claude Code session:
   every turn is one command, state persists in .gauntlet/state.json,
   each command prints the full rendered battle frame (ANSI + sprites).

   Commands:
     node game.js start                 new run → draft screen
     node game.js pick <1-3>            choose starter → battle
     node game.js move <1-4>            attack
     node game.js switch <1-3>          swap team member (costs the turn)
     node game.js reward <restore|train <n>|recruit [slot]>
     node game.js status                reprint current screen
     node game.js                       interactive REPL (same verbs)
   ===================================================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

/* ---------------- CONFIG / DATA ---------------- */

const CONFIG = {
  MAX_DEX_ID: 1025,
  TEAM_SIZE: 3,
  START_LEVEL: 50,
  LEVEL_PER_WIN: 2,
  BOSS_EVERY: 5,
  MOVE_COUNT: 4,
  CRIT_RATE: 1 / 16,
  CRIT_MULT: 1.5,
  STAB: 1.5,
  POST_WIN_HEAL: 0.2,
  TRAIN_ADD: 0.10,        // train is additive (+10% of base per claim) — linear growth
  FOE_RAMP: 1.02,         // enemy stat multiplier compounds per round — the wall always arrives
  SPRITE_COLS: 34,        // sprite render width in terminal columns
  BST_PIVOT: 480,         // BST level compensation: weak mons fight above their
  SCALE_MIN: 0.85,        //   level, strong ones below. Keeps the full dex
  SCALE_MAX: 1.25,        //   draftable; the pick is typing/moves/stat shape.
};

const DIR = path.join(process.cwd(), ".gauntlet");
const STATE_FILE = path.join(DIR, "state.json");
const CACHE_FILE = path.join(DIR, "cache.json");

const TYPE_COLORS = {
  normal:[168,167,122], fire:[238,129,48], water:[99,144,240], electric:[247,208,44],
  grass:[122,199,76], ice:[150,217,214], fighting:[194,46,40], poison:[163,62,161],
  ground:[226,191,101], flying:[169,143,243], psychic:[249,85,135], bug:[166,185,26],
  rock:[182,161,54], ghost:[115,87,151], dragon:[111,53,252], dark:[150,110,90],
  steel:[183,183,206], fairy:[214,133,173],
};

/* Attacker → { defender: multiplier }. Omitted pairs are 1×. */
const TYPE_CHART = {
  normal:{rock:.5,ghost:0,steel:.5},
  fire:{fire:.5,water:.5,grass:2,ice:2,bug:2,rock:.5,dragon:.5,steel:2},
  water:{fire:2,water:.5,grass:.5,ground:2,rock:2,dragon:.5},
  electric:{water:2,electric:.5,grass:.5,ground:0,flying:2,dragon:.5},
  grass:{fire:.5,water:2,grass:.5,poison:.5,ground:2,flying:.5,bug:.5,rock:2,dragon:.5,steel:.5},
  ice:{fire:.5,water:.5,grass:2,ice:.5,ground:2,flying:2,dragon:2,steel:.5},
  fighting:{normal:2,ice:2,poison:.5,flying:.5,psychic:.5,bug:.5,rock:2,ghost:0,dark:2,steel:2,fairy:.5},
  poison:{grass:2,poison:.5,ground:.5,rock:.5,ghost:.5,steel:0,fairy:2},
  ground:{fire:2,electric:2,grass:.5,poison:2,flying:0,bug:.5,rock:2,steel:2},
  flying:{electric:.5,grass:2,fighting:2,bug:2,rock:.5,steel:.5},
  psychic:{fighting:2,poison:2,psychic:.5,dark:0,steel:.5},
  bug:{fire:.5,grass:2,fighting:.5,poison:.5,flying:.5,psychic:2,ghost:.5,dark:2,steel:.5,fairy:.5},
  rock:{fire:2,ice:2,fighting:.5,ground:.5,flying:2,bug:2,steel:.5},
  ghost:{normal:0,psychic:2,ghost:2,dark:.5},
  dragon:{dragon:2,steel:.5,fairy:0},
  dark:{fighting:.5,psychic:2,ghost:2,dark:.5,fairy:.5},
  steel:{fire:.5,water:.5,electric:.5,ice:2,rock:2,steel:.5,fairy:2},
  fairy:{fire:.5,fighting:2,poison:.5,dragon:2,dark:2,steel:.5},
};

const BOSS_IDS = [
  144,145,146,150,151,243,244,245,249,250,251,377,378,379,380,381,382,383,384,
  385,386,480,481,482,483,484,485,486,487,488,489,490,491,492,493,638,639,640,
  641,642,643,644,645,646,647,648,649,716,717,718,719,720,721,785,786,787,788,
  789,790,791,792,800,801,802,807,888,889,890,891,892,893,894,895,896,897,898,
  905,1001,1002,1003,1004,1007,1008,1014,1015,1016,1017,1024,1025,
];

const FALLBACK_MOVE = { name:"strike", power:50, accuracy:100, type:"normal", cls:"physical" };

/* ---------------- ANSI ---------------- */

const COLOR = !("NO_COLOR" in process.env);
const esc = s => COLOR ? s : "";
const RST = esc("\x1b[0m");
const BOLD = esc("\x1b[1m");
const DIM = esc("\x1b[2m");
const fg = ([r,g,b]) => esc(`\x1b[38;2;${r};${g};${b}m`);
const bg = ([r,g,b]) => esc(`\x1b[48;2;${r};${g};${b}m`);
const GRAY = fg([118,130,143]);
const FAINT = fg([74,84,95]);
const RED = fg([229,72,77]);
const GREEN = fg([70,167,88]);
const AMBER = fg([216,160,61]);

const typeFg = t => fg(TYPE_COLORS[t] || TYPE_COLORS.normal);

/* ---------------- UTIL ---------------- */

const rand = (a,b) => a + Math.random()*(b-a);
const ri = (a,b) => Math.floor(rand(a, b+1));
const pick = arr => arr[Math.floor(Math.random()*arr.length)];
const cap = s => s.split("-").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const pad = (s, n) => s + " ".repeat(Math.max(0, n - visibleLen(s)));
const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function effectiveness(moveType, defenderTypes){
  return defenderTypes.reduce((m,t) => m * (TYPE_CHART[moveType]?.[t] ?? 1), 1);
}

/* ---------------- PERSISTENCE ---------------- */

function loadJSON(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e){ return fallback; }
}
function saveJSON(file, data){
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
let S = loadJSON(STATE_FILE, { screen:"none", best:0 });
const cache = loadJSON(CACHE_FILE, {});
function persist(){ saveJSON(STATE_FILE, S); saveJSON(CACHE_FILE, cache); }

/* ---------------- API ---------------- */

const volatile = new Map(); // large responses, never persisted
async function getJSON(url, retries=2){
  if (cache[url]) return cache[url];
  if (volatile.has(url)) return volatile.get(url);
  const persistable = !url.includes("/pokemon/") && !url.includes("/pokemon-species/");
  for (let i=0; i<=retries; i++){
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP "+res.status);
      const data = await res.json();
      if (persistable) cache[url] = data; else volatile.set(url, data);
      return data;
    } catch(e){
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 350*(i+1)));
    }
  }
}

async function getPNG(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP "+res.status);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------------- PNG DECODE (no deps) ---------------- */
/* Supports color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+A), 6 (RGBA),
   bit depth 8, non-interlaced. Returns {width, height, get(x,y)→[r,g,b,a]}. */

function decodePNG(buf){
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w=0, h=0, depth=0, ctype=0, interlace=0;
  let idat = [], plte = null, trns = null;
  while (pos < buf.length){
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos+4, pos+8);
    const data = buf.subarray(pos+8, pos+8+len);
    if (type === "IHDR"){
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE"){ plte = data; }
    else if (type === "tRNS"){ trns = data; }
    else if (type === "IDAT"){ idat.push(data); }
    else if (type === "IEND"){ break; }
    pos += 12 + len;
  }
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const channels = {0:1, 2:3, 3:1, 4:2, 6:4}[ctype];
  if (!channels) throw new Error("unsupported color type");
  if (depth !== 8 && !((ctype === 0 || ctype === 3) && [1,2,4].includes(depth)))
    throw new Error("unsupported bit depth");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(w * channels * depth / 8);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y=0; y<h; y++){
    const filter = raw[p++];
    for (let x=0; x<stride; x++){
      const cur = raw[p++];
      const left = x >= bpp ? out[y*stride + x - bpp] : 0;
      const up = y > 0 ? out[(y-1)*stride + x] : 0;
      const ul = (y > 0 && x >= bpp) ? out[(y-1)*stride + x - bpp] : 0;
      let v;
      switch (filter){
        case 0: v = cur; break;
        case 1: v = cur + left; break;
        case 2: v = cur + up; break;
        case 3: v = cur + ((left + up) >> 1); break;
        case 4: {
          const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2*ul);
          v = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: throw new Error("bad filter");
      }
      out[y*stride + x] = v & 0xff;
    }
  }
  function chan(x, y, c){
    if (depth === 8) return out[y*stride + x*channels + c];
    const bitpos = (x*channels + c) * depth;
    const byte = out[y*stride + (bitpos >> 3)];
    const shift = 8 - depth - (bitpos & 7);
    return (byte >> shift) & ((1 << depth) - 1);
  }
  const gscale = depth === 8 ? 1 : 255 / ((1 << depth) - 1);
  function get(x, y){
    switch (ctype){
      case 0: { const g = Math.round(chan(x,y,0)*gscale); return [g, g, g, 255]; }
      case 2: { const i = y*stride + x*3; return [out[i], out[i+1], out[i+2], 255]; }
      case 3: {
        const idx = chan(x,y,0);
        const a = trns && idx < trns.length ? trns[idx] : 255;
        return [plte[idx*3], plte[idx*3+1], plte[idx*3+2], a];
      }
      case 4: { const i = y*stride + x*2; return [out[i], out[i], out[i], out[i+1]]; }
      case 6: { const i = y*stride + x*4; return [out[i], out[i+1], out[i+2], out[i+3]]; }
    }
  }
  return { width:w, height:h, get };
}

/* ---------------- SPRITE → HALF-BLOCK ART ---------------- */

function spriteToLines(png, cols){
  // crop to opaque bounding box
  let minX=png.width, minY=png.height, maxX=-1, maxY=-1;
  for (let y=0; y<png.height; y++) for (let x=0; x<png.width; x++){
    if (png.get(x,y)[3] > 40){
      if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
    }
  }
  if (maxX < 0) return [];
  const cw = maxX-minX+1, ch = maxY-minY+1;
  const rows = Math.max(2, Math.round(cols * (ch/cw))) & ~1; // even, 1 char ≈ 2px tall
  const sample = (cx, ry) => {
    const x = minX + Math.floor(cx * cw / cols);
    const y = minY + Math.floor(ry * ch / rows);
    return png.get(Math.min(maxX,x), Math.min(maxY,y));
  };
  const lines = [];
  for (let r=0; r<rows; r+=2){
    let line = "";
    for (let c=0; c<cols; c++){
      const t = sample(c, r), b = sample(c, r+1);
      const tOn = t[3] > 40, bOn = b[3] > 40;
      if (!tOn && !bOn) line += " ";
      else if (tOn && bOn) line += fg(t)+bg(b)+"▀"+RST;
      else if (tOn) line += fg(t)+"▀"+RST;
      else line += fg(b)+"▄"+RST;
    }
    lines.push(line.replace(/\s+$/,""));
  }
  return lines;
}

/* Plain variant for transcript contexts: luminance → shade ramp, no ANSI. */
function spriteToPlain(png, cols){
  let minX=png.width, minY=png.height, maxX=-1, maxY=-1;
  for (let y=0; y<png.height; y++) for (let x=0; x<png.width; x++){
    if (png.get(x,y)[3] > 40){
      if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
    }
  }
  if (maxX < 0) return [];
  const cw = maxX-minX+1, ch = maxY-minY+1;
  const rows = Math.max(2, Math.round(cols * (ch/cw))) & ~1;
  const RAMP = "░▒▓█";
  const sample = (cx, ry) => {
    const x = minX + Math.floor(cx * cw / cols);
    const y = minY + Math.floor(ry * ch / rows);
    return png.get(Math.min(maxX,x), Math.min(maxY,y));
  };
  const lines = [];
  for (let r=0; r<rows; r+=2){
    let line = "";
    for (let c=0; c<cols; c++){
      const t = sample(c, r), b = sample(c, r+1);
      const on = px => px[3] > 40;
      if (!on(t) && !on(b)){ line += " "; continue; }
      const px = on(t) && on(b) ? [(t[0]+b[0])/2,(t[1]+b[1])/2,(t[2]+b[2])/2] : on(t) ? t : b;
      const L = 0.2126*px[0] + 0.7152*px[1] + 0.0722*px[2];
      line += RAMP[Math.min(3, Math.floor(L/64))];
    }
    lines.push(line.replace(/\s+$/,""));
  }
  return lines;
}

async function fetchSpriteLines(mon){
  const key = "art2:" + mon.spriteUrl;
  if (cache[key]) return cache[key];
  try {
    const png = decodePNG(await getPNG(mon.spriteUrl));
    const both = {
      color: spriteToLines(png, CONFIG.SPRITE_COLS),
      plain: spriteToPlain(png, CONFIG.SPRITE_COLS),
    };
    cache[key] = both;
    return both;
  } catch(e){
    const fb = "[" + mon.name.toLowerCase() + "]";
    return { color: [FAINT + fb + RST], plain: [fb] };
  }
}

/* ---------------- BUILDERS ---------------- */

function bstScale(base){
  const bst = Object.values(base).reduce((a,b)=>a+b, 0);
  return Math.min(CONFIG.SCALE_MAX, Math.max(CONFIG.SCALE_MIN, CONFIG.BST_PIVOT / bst));
}

function statsAt(base, level, boost){
  const lv = Math.round(level * bstScale(base));
  const f = s => Math.floor(2*s*lv/100) + 5;
  return {
    maxhp: Math.floor(2*base.hp*lv/100) + lv + 10,
    atk: Math.floor(f(base.atk)*boost),
    def: Math.floor(f(base.def)*boost),
    spa: Math.floor(f(base.spa)*boost),
    spd: Math.floor(f(base.spd)*boost),
    spe: Math.floor(f(base.spe)*boost),
  };
}

async function buildMoves(raw){
  const candidates = shuffle(raw.moves.map(m => m.move.url));
  const out = [];
  let attempts = 0;
  for (const url of candidates){
    if (out.length >= CONFIG.MOVE_COUNT || attempts >= 16) break;
    attempts++;
    try {
      const m = await getJSON(url);
      if (!m.power || m.damage_class.name === "status") continue;
      if (out.some(x => x.name === m.name)) continue;
      out.push({ name:m.name, power:m.power, accuracy:m.accuracy ?? 100, type:m.type.name, cls:m.damage_class.name });
    } catch(e){ /* skip */ }
  }
  if (out.length === 0) out.push({ ...FALLBACK_MOVE });
  return out;
}

async function buildMon(id, level){
  const p = await getJSON(`https://pokeapi.co/api/v2/pokemon/${id}`);
  const spriteUrl = p.sprites.front_default;
  if (!spriteUrl) throw new Error("no sprite");
  const backSprite = p.sprites.back_default || spriteUrl;
  const base = {
    hp:  p.stats.find(s=>s.stat.name==="hp").base_stat,
    atk: p.stats.find(s=>s.stat.name==="attack").base_stat,
    def: p.stats.find(s=>s.stat.name==="defense").base_stat,
    spa: p.stats.find(s=>s.stat.name==="special-attack").base_stat,
    spd: p.stats.find(s=>s.stat.name==="special-defense").base_stat,
    spe: p.stats.find(s=>s.stat.name==="speed").base_stat,
  };
  const moves = await buildMoves(p);
  const mon = {
    id: p.id, level,
    name: cap(p.name),
    types: p.types.map(t => t.type.name),
    base, boost: 1, spriteUrl, backSprite, moves,
    baseExp: p.base_experience || 60,
    speciesUrl: p.species?.url || null,
    exp: Math.pow(level, 3),
    hp: 0, stats: null,
  };
  mon.stats = statsAt(base, level, mon.boost);
  mon.hp = mon.stats.maxhp;
  return mon;
}

const BOSS_SET = new Set(BOSS_IDS);
async function randomMon(level, pool=null){
  for (let i=0; i<9; i++){
    try {
      let id;
      if (pool) id = pick(pool);
      else {
        do { id = ri(1, CONFIG.MAX_DEX_ID); } while (BOSS_SET.has(id));
      }
      return await buildMon(id, level);
    } catch(e){ /* re-roll */ }
  }
  throw new Error("PokeAPI unreachable — check the connection and retry");
}

function relevel(mon, level){
  const pct = mon.hp / mon.stats.maxhp;
  mon.level = level;
  mon.stats = statsAt(mon.base, level, mon.boost);
  mon.hp = Math.min(mon.stats.maxhp, Math.ceil(mon.stats.maxhp * Math.min(1, pct + CONFIG.POST_WIN_HEAL)));
}

function applyTrain(mon){
  const pct = mon.hp / mon.stats.maxhp;
  mon.boost += CONFIG.TRAIN_ADD;
  mon.stats = statsAt(mon.base, mon.level, mon.boost);
  mon.hp = Math.ceil(mon.stats.maxhp * pct);
}

/* ---------------- BATTLE MATH ---------------- */

function computeDamage(attacker, defender, mv){
  const eff = effectiveness(mv.type, defender.types);
  if (eff === 0) return { dmg:0, eff, crit:false };
  const A = mv.cls === "special" ? attacker.stats.spa : attacker.stats.atk;
  const D = mv.cls === "special" ? defender.stats.spd : defender.stats.def;
  const crit = Math.random() < CONFIG.CRIT_RATE;
  const stab = attacker.types.includes(mv.type) ? CONFIG.STAB : 1;
  const lv = Math.round(attacker.level * bstScale(attacker.base));
  let dmg = Math.floor(Math.floor(Math.floor(2*lv/5+2) * mv.power * A / D) / 50) + 2;
  dmg = Math.floor(dmg * stab * eff * (crit ? CONFIG.CRIT_MULT : 1) * rand(0.85, 1));
  return { dmg: Math.max(1, dmg), eff, crit };
}

function enemyChooseMove(enemy, target){
  let best = enemy.moves[0], bestScore = -1;
  for (const mv of enemy.moves){
    const eff = effectiveness(mv.type, target.types);
    const stab = enemy.types.includes(mv.type) ? CONFIG.STAB : 1;
    const score = mv.power * eff * stab * (mv.accuracy/100) * rand(0.8, 1.2);
    if (score > bestScore){ bestScore = score; best = mv; }
  }
  return best;
}

/* ---------------- RUN STATE HELPERS ---------------- */

function teamLevel(round){ return CONFIG.START_LEVEL + (round-1)*CONFIG.LEVEL_PER_WIN; }
function enemyLevel(round, boss){ return teamLevel(round) + Math.floor(round/3) + (boss ? 4 : 0); }
function isBossRound(round){ return round % CONFIG.BOSS_EVERY === 0; }
function active(){ return S.run.team[S.run.activeIdx]; }

/* ---------------- RENDER ---------------- */

const W = 78;
const STRIP = str => str.replace(/\x1b\[[0-9;]*m/g, "");
const out = [];                                  // entries: {color, plain}
const print = (s="") => out.push({ color: s, plain: STRIP(s) });
const printPair = (color, plain) => out.push({ color, plain });

/* Dual-channel emit. stdout is a TTY → human at a terminal: full color there.
   stdout captured (Claude Code tool call) → compact plain frame to stdout for
   the transcript, and the full-color frame painted straight onto the user's
   terminal via /dev/tty so the session shows real sprites. */
function flushOut(){
  const colorFrame = out.map(e => e.color).join("\n") + "\n";
  const plainFrame = out.map(e => e.plain).join("\n") + "\n";
  out.length = 0;
  if (process.stdout.isTTY){
    process.stdout.write(COLOR ? colorFrame : plainFrame);
    return;
  }
  process.stdout.write(plainFrame);
  if (COLOR && process.env.GAUNTLET_TTY !== "0"){
    try {
      const fd = fs.openSync("/dev/tty", "w");
      fs.writeSync(fd, colorFrame);
      fs.closeSync(fd);
    } catch(e){ /* no controlling terminal — plain frame already covers it */ }
  }
}

function rule(label=""){
  const l = label ? ` ${label} ` : "";
  print(FAINT + "─".repeat(2) + RST + (label ? GRAY + l + RST : "") + FAINT + "─".repeat(Math.max(0, W - 2 - visibleLen(l))) + RST);
}

function hpbar(mon, width=22){
  const pct = Math.max(0, mon.hp / mon.stats.maxhp);
  const fill = Math.round(pct * width);
  const col = pct <= .2 ? RED : pct <= .5 ? AMBER : GREEN;
  return col + "█".repeat(fill) + FAINT + "░".repeat(width - fill) + RST +
         GRAY + ` ${Math.max(0,mon.hp)}/${mon.stats.maxhp}` + RST;
}

function typeLabel(types){
  return types.map(t => typeFg(t) + t + RST).join(GRAY + "/" + RST);
}

function header(){
  print("");
  const acc = S.mode === "campaign" && S.camp?.party?.length ? S.camp.party[S.camp.activeIdx]
            : (S.run && active() ? active() : null);
  const left = BOLD + typeFg(acc ? acc.types[0] : "normal") + "GAUNTLET" + RST +
               GRAY + "  endless draft battler" + RST;
  const right = FAINT + "best streak " + RST + GRAY + S.best + RST;
  print(left + " ".repeat(Math.max(1, W - visibleLen(left) - visibleLen(right))) + right);
}

function plate(mon, who){
  print(BOLD + pad(who, 5) + RST + BOLD + pad(mon.name, 14) + RST +
        GRAY + `Lv.${mon.level}  ` + RST + pad(typeLabel(mon.types), 18) + " " + hpbar(mon));
}

function printSprite(art, indent){
  const n = art.color.length;
  for (let i=0; i<n; i++)
    printPair(" ".repeat(indent) + art.color[i], " ".repeat(indent) + (art.plain[i] || ""));
}

function teamLine(){
  const parts = S.run.team.map((m,i) => {
    const tag = i === S.run.activeIdx ? typeFg(m.types[0]) + "▶" + RST : " ";
    const hp = m.hp <= 0 ? RED + "FNT" + RST : GRAY + `${m.hp}/${m.stats.maxhp}` + RST;
    return `${tag}${i+1}) ${m.hp<=0?DIM:""}${m.name}${RST} ${hp}`;
  });
  for (let i = S.run.team.length; i < CONFIG.TEAM_SIZE; i++) parts.push(FAINT + ` ${i+1}) —` + RST);
  print(parts.join("   "));
}

function movesBlock(){
  const foe = S.run.enemy;
  S.run.team[S.run.activeIdx].moves.forEach((m,i) => {
    const eff = effectiveness(m.type, foe.types);
    const hint = eff === 0 ? RED+"×0"+RST : eff > 1 ? AMBER+"×"+eff+RST : eff < 1 ? FAINT+"×"+eff+RST : "  ";
    print(`  ${i+1}) ` + pad(typeFg(m.type) + cap(m.name) + RST, 26) +
          GRAY + pad(m.type, 9) + pad("pow "+m.power, 9) + pad("acc "+m.accuracy, 9) + RST + hint);
  });
}

function logBlock(){
  if (!S.run.log?.length) return;
  rule("LOG");
  for (const l of S.run.log.slice(-7)) print("  " + GRAY + "> " + RST + l);
}

function battleLog(){ return S.camp?.battle ? (S.camp.battle.log ??= []) : (S.run.log ??= []); }
function logp(text){ battleLog().push(text); }
function foeLabel(mon){ return (S.camp?.battle?.kind === "trainer" ? "Enemy " : "Wild ") + mon.name; }

async function renderBattle(prompt=true){
  const foe = S.run.enemy, me = active();
  const [foeArt, meArt] = await Promise.all([fetchSpriteLines(foe), fetchSpriteLines(me)]);
  header();
  rule(`ROUND ${String(S.run.round).padStart(2,"0")}` + (isBossRound(S.run.round) ? "  ·  LEGENDARY" : ""));
  print("");
  plate(foe, "FOE");
  printSprite(foeArt, W - CONFIG.SPRITE_COLS - 4);
  printSprite(meArt, 4);
  plate(me, "YOU");
  print("");
  rule("TEAM");
  teamLine();
  rule("MOVES");
  movesBlock();
  logBlock();
  if (prompt){
    rule();
    if (S.run.mustSwitch){
      print(BOLD + "  Your active member fainted — pick a replacement: " + RST + GRAY + "switch <n>" + RST);
    } else {
      print(GRAY + "  next: " + RST + "move <1-4>" + GRAY + " · " + RST + "switch <1-" + S.run.team.length + ">" + GRAY + "  (switching spends the turn)" + RST);
    }
  }
  print("");
}

async function renderDraft(){
  header();
  rule("OPENING DRAFT");
  print("");
  print(GRAY + `  Three pulls from the full Pokédex at Lv.${teamLevel(1)}. Real stats, four real` + RST);
  print(GRAY + `  damaging moves from each learnset. Pick one — the rest are gone for good.` + RST);
  for (let i=0; i<S.draft.length; i++){
    const m = S.draft[i];
    const art = await fetchSpriteLines(m);
    print("");
    rule(`OPTION ${i+1}`);
    printSprite(art, 4);
    print("  " + BOLD + m.name + RST + "  " + GRAY + `#${String(m.id).padStart(4,"0")}  Lv.${m.level}  ` + RST + typeLabel(m.types));
    const s = m.stats;
    print("  " + GRAY + `HP ${s.maxhp}  ATK ${s.atk}  DEF ${s.def}  SPA ${s.spa}  SPD ${s.spd}  SPE ${s.spe}` + RST);
    print("  " + m.moves.map(mv => typeFg(mv.type) + cap(mv.name) + RST + GRAY + " " + mv.power + RST).join(GRAY + " · " + RST));
  }
  print("");
  rule();
  print(GRAY + "  next: " + RST + "pick <1-3>");
  print("");
}

async function renderReward(){
  const cleared = S.run.round - 1;
  header();
  rule(`ROUND ${cleared} CLEARED`);
  print("");
  print(GRAY + `  Team leveled to ${teamLevel(S.run.round)} (+20% heal). Fainted members stay down.` + RST);
  print(GRAY + `  Next: round ${S.run.round}` + (isBossRound(S.run.round) ? RED + " — a legendary is waiting." + RST : ".") + RST);
  print("");
  print(GRAY + "  This round offers two of the three rewards. Claim one." + RST);
  print("");
  const r = S.recruit;
  if (S.offers.includes("recruit") && r){
    const art = await fetchSpriteLines(r);
    rule("RECRUIT");
    printSprite(art, 4);
    print("  " + BOLD + r.name + RST + "  " + GRAY + `Lv.${r.level}  ` + RST + typeLabel(r.types) +
          GRAY + `   HP ${r.stats.maxhp} ATK ${r.stats.atk} DEF ${r.stats.def} SPA ${r.stats.spa} SPD ${r.stats.spd} SPE ${r.stats.spe}` + RST);
    print("  " + r.moves.map(mv => typeFg(mv.type) + cap(mv.name) + RST + GRAY + " " + mv.power + RST).join(GRAY + " · " + RST));
  }
  if (S.offers.includes("restore")){
    rule("RESTORE");
    print("  " + BOLD + "RESTORE" + RST + GRAY + " — full HP for everyone, fainted members revived" + RST);
  }
  if (S.offers.includes("train")){
    rule("TRAIN");
    print("  " + BOLD + "TRAIN <n>" + RST + GRAY + " — permanent +10% all stats on one member (compounds)" + RST);
  }
  print("");
  rule("TEAM");
  teamLine();
  rule();
  const full = S.run.team.length >= CONFIG.TEAM_SIZE;
  const opts = S.offers.map(o =>
    o === "recruit" ? (full ? "reward recruit <slot 1-3 to replace>" : "reward recruit")
    : o === "restore" ? "reward restore"
    : "reward train <1-" + S.run.team.length + ">");
  print(GRAY + "  next: " + RST + opts.join(GRAY + " · " + RST));
  print("");
}

async function renderOver(){
  const cleared = S.finalScore;
  header();
  rule();
  print("");
  print("  " + RED + BOLD + "TEAM WIPED" + RST);
  print("");
  print(`  Rounds cleared: ${BOLD}${cleared}${RST}   ${GRAY}best: ${S.best}${RST}`);
  for (const m of S.finalTeam) print("  " + FAINT + `${m.name} Lv.${m.level}` + RST);
  print("");
  rule();
  print(GRAY + "  next: " + RST + "start");
  print("");
}

async function renderCurrent(){
  switch (S.screen){
    case "draft": await renderDraft(); break;
    case "battle": await renderBattle(); break;
    case "reward": await renderReward(); break;
    case "over": await renderOver(); break;
    default:
      print("");
      print(BOLD + "GAUNTLET" + RST + GRAY + " — no run in progress." + RST);
      print(GRAY + "  next: " + RST + "start");
      print("");
  }
}

/* ---------------- ACTIONS ---------------- */

function fail(msg){
  print("");
  print(RED + "  " + msg + RST);
  print("");
}

async function actStart(){
  const lvl = teamLevel(1);
  S = { screen:"draft", best: S.best || 0, mode: "arcade", camp: S.camp || null };
  S.draft = await Promise.all([randomMon(lvl), randomMon(lvl), randomMon(lvl)]);
  S.run = null;
  await renderDraft();
}

async function actPick(n){
  if (S.screen !== "draft") return fail("Nothing to pick — current screen: " + S.screen + ".");
  const i = n - 1;
  if (!S.draft[i]) return fail("pick 1, 2, or 3.");
  S.run = { round:1, team:[S.draft[i]], activeIdx:0, enemy:null, log:[], mustSwitch:false };
  S.draft = null;
  await nextBattle();
}

async function nextBattle(){
  const boss = isBossRound(S.run.round);
  S.run.enemy = await randomMon(enemyLevel(S.run.round, boss), boss ? BOSS_IDS : null);
  const e = S.run.enemy;
  e.boost = Math.pow(CONFIG.FOE_RAMP, S.run.round - 1);
  e.stats = statsAt(e.base, e.level, e.boost);
  e.hp = e.stats.maxhp;
  S.run.log = [];
  S.screen = "battle";
  logp(boss ? `Round ${S.run.round}. A legendary blocks the path: ${BOLD}${S.run.enemy.name}${RST} Lv.${S.run.enemy.level}.`
            : `Round ${S.run.round}. Wild ${BOLD}${S.run.enemy.name}${RST} Lv.${S.run.enemy.level} steps in.`);
  await renderBattle();
}

function strike(attacker, defender, mv, attackerIsFoe){
  const who = attackerIsFoe ? foeLabel(attacker) : attacker.name;
  if (Math.random()*100 > mv.accuracy){
    logp(`${who} used ${cap(mv.name)} — ${DIM}it missed.${RST}`);
    return;
  }
  const { dmg, eff, crit } = computeDamage(attacker, defender, mv);
  defender.hp = Math.max(0, defender.hp - dmg);
  let note = "";
  if (eff === 0){ logp(`${who} used ${cap(mv.name)} — ${FAINT}it doesn't affect ${defender.name}.${RST}`); return; }
  void 0;
  if (eff > 1) note += AMBER + " super effective!" + RST;
  if (eff < 1) note += FAINT + " not very effective." + RST;
  if (crit) note += RED + " critical hit!" + RST;
  logp(`${who} used ${typeFg(mv.type)}${cap(mv.name)}${RST} — ${BOLD}${dmg}${RST} damage.${note}`);
}

async function actMove(n){
  if (S.screen !== "battle") return fail("Not in battle — current screen: " + S.screen + ".");
  if (S.run.mustSwitch) return fail("Active member is down. switch <n> first.");
  const me = active(), foe = S.run.enemy;
  const mv = me.moves[n-1];
  if (!mv) return fail("move 1-" + me.moves.length + ".");
  const foeMove = enemyChooseMove(foe, me);
  const meFirst = me.stats.spe === foe.stats.spe ? Math.random() < .5 : me.stats.spe > foe.stats.spe;
  const order = meFirst ? [[me,foe,mv,false],[foe,me,foeMove,true]] : [[foe,me,foeMove,true],[me,foe,mv,false]];
  for (const [a,d,m,foeAttacks] of order){
    if (a.hp <= 0) continue;
    strike(a, d, m, foeAttacks);
    if (foe.hp <= 0) return winRound();
    if (me.hp <= 0) return playerFaint();
  }
  await renderBattle();
}

async function actSwitch(n){
  if (S.screen !== "battle") return fail("Not in battle — current screen: " + S.screen + ".");
  const i = n - 1;
  const target = S.run.team[i];
  if (!target) return fail("switch 1-" + S.run.team.length + ".");
  if (i === S.run.activeIdx) return fail(target.name + " is already out.");
  if (target.hp <= 0) return fail(target.name + " has fainted.");
  S.run.activeIdx = i;
  logp(`${BOLD}${target.name}${RST} takes the field.`);
  if (S.run.mustSwitch){
    S.run.mustSwitch = false;       // free switch after a faint
  } else {
    const foe = S.run.enemy;
    strike(foe, target, enemyChooseMove(foe, target), true);
    if (target.hp <= 0) return playerFaint();
  }
  await renderBattle();
}

async function playerFaint(){
  const me = active();
  logp(`${BOLD}${me.name}${RST} ${RED}fainted.${RST}`);
  const alive = S.run.team.map((m,i)=>({m,i})).filter(x => x.m.hp > 0);
  if (alive.length === 0){
    S.finalScore = S.run.round - 1;
    S.finalTeam = S.run.team.map(m => ({ name:m.name, level:m.level }));
    if (S.finalScore > S.best) S.best = S.finalScore;
    S.screen = "over";
    S.run = null;
    await renderOver();
    return;
  }
  if (alive.length === 1){
    S.run.activeIdx = alive[0].i;
    logp(`${BOLD}${active().name}${RST} takes the field.`);
    await renderBattle();
    return;
  }
  S.run.mustSwitch = true;
  await renderBattle();
}

async function winRound(){
  logp(`Wild ${BOLD}${S.run.enemy.name}${RST} fainted. ${GREEN}Round ${S.run.round} cleared.${RST}`);
  S.run.round++;
  const cleared = S.run.round - 1;
  if (cleared > S.best) S.best = cleared;
  const lvl = teamLevel(S.run.round);
  S.run.team.forEach(m => {
    if (m.hp > 0) relevel(m, lvl);
    else { m.level = lvl; m.stats = statsAt(m.base, lvl, m.boost); }
  });
  S.offers = shuffle(["recruit","restore","train"]).slice(0, 2);
  S.recruit = S.offers.includes("recruit") ? await randomMon(lvl) : null;
  S.screen = "reward";
  await renderReward();
}

async function actReward(kind, n){
  if (S.screen !== "reward") return fail("No reward pending — current screen: " + S.screen + ".");
  if (!S.offers.includes(kind))
    return fail("Not offered this round. On the table: " + S.offers.join(", ") + ".");
  if (kind === "restore"){
    S.run.team.forEach(m => m.hp = m.stats.maxhp);
  } else if (kind === "train"){
    const m = S.run.team[(n||0) - 1];
    if (!m) return fail("reward train <1-" + S.run.team.length + ">.");
    applyTrain(m);
  } else if (kind === "recruit"){
    const r = S.recruit;
    if (!r) return fail("No recruit available.");
    if (S.run.team.length < CONFIG.TEAM_SIZE){
      S.run.team.push(r);
    } else {
      const i = (n||0) - 1;
      if (!S.run.team[i]) return fail("Team is full — reward recruit <slot 1-3 to replace>.");
      S.run.team[i] = r;
      if (active().hp <= 0) S.run.activeIdx = S.run.team.findIndex(m => m.hp > 0);
    }
  } else {
    return fail("reward restore · reward train <n> · reward recruit [slot]");
  }
  S.recruit = null;
  S.offers = [];
  await nextBattle();
}


/* ---------------- CAMPAIGN MODE ---------------- */
/* Journey play: trainer card, party of 6, box, money, items. Wild encounters
   grounded in PokeAPI location data; trainer battles staged by the GM.
   Loss = blackout (heal + half money), never permadeath. */

const STARTERS = [1,4,7,152,155,158,252,255,258,387,390,393,495,498,501,650,653,656,722,725,728,810,813,816,906,909,912];
const MART = { pokeball:200, greatball:600, ultraball:1200, potion:300 };
const BALL_MULT = { pokeball:1, greatball:1.5, ultraball:2 };
const CAMP_START = { money:3000, balls:{ pokeball:5, greatball:0, ultraball:0 }, potions:2 };

function camp(){ return S.camp; }
function partyActive(){ return S.camp.party[S.camp.activeIdx]; }
function expFor(level){ return Math.pow(level, 3); }

function gainExp(mon, foe){
  const gain = Math.floor(foe.baseExp * foe.level / 7);
  mon.exp = (mon.exp || expFor(mon.level)) + gain;
  logp(`${mon.name} gained ${BOLD}${gain}${RST} EXP.`);
  while (mon.exp >= expFor(mon.level + 1) && mon.level < 100){
    const pct = mon.hp / mon.stats.maxhp;
    mon.level++;
    mon.stats = statsAt(mon.base, mon.level, mon.boost);
    mon.hp = Math.ceil(mon.stats.maxhp * pct);
    logp(`${BOLD}${mon.name}${RST} grew to ${GREEN}Lv.${mon.level}${RST}!`);
  }
}

async function captureRate(mon){
  if (mon.captureRate != null) return mon.captureRate;
  try {
    const sp = await getJSON(mon.speciesUrl);
    mon.captureRate = sp.capture_rate ?? 45;
  } catch(e){ mon.captureRate = 45; }
  return mon.captureRate;
}

/* ----- world grounding: PokeAPI locations ----- */

async function locationEncounters(locName){
  S.camp.encCache ??= {};
  if (S.camp.encCache[locName]) return S.camp.encCache[locName];
  const loc = await getJSON(`https://pokeapi.co/api/v2/location/${locName}`);
  const table = new Map();
  for (const area of loc.areas){
    let a;
    try { a = await getJSON(area.url); } catch(e){ continue; }
    for (const pe of a.pokemon_encounters || []){
      const name = pe.pokemon.name;
      const cur = table.get(name) || { species:name, min:100, max:1, chance:0 };
      for (const vd of pe.version_details || []){
        cur.chance = Math.max(cur.chance, vd.max_chance || 0);
        for (const ed of vd.encounter_details || []){
          cur.min = Math.min(cur.min, ed.min_level ?? cur.min);
          cur.max = Math.max(cur.max, ed.max_level ?? cur.max);
        }
      }
      table.set(name, cur);
    }
  }
  const out = [...table.values()].filter(e => e.chance > 0);
  S.camp.encCache[locName] = out;
  return out;
}

/* ----- campaign screens ----- */

async function renderStarter(){
  header();
  rule("CHOOSE YOUR STARTER");
  for (let i=0; i<S.camp.draft.length; i++){
    const m = S.camp.draft[i];
    const art = await fetchSpriteLines(m);
    print("");
    rule(`OPTION ${i+1}`);
    printSprite(art, 4);
    print("  " + BOLD + m.name + RST + "  " + GRAY + `Lv.${m.level}  ` + RST + typeLabel(m.types));
    print("  " + m.moves.map(mv => typeFg(mv.type) + cap(mv.name) + RST + GRAY + " " + mv.power + RST).join(GRAY + " · " + RST));
  }
  print("");
  rule();
  print(GRAY + "  next: " + RST + "pick <1-3>");
  print("");
}

function partyLine(){
  const parts = S.camp.party.map((m,i) => {
    const tag = i === S.camp.activeIdx ? typeFg(m.types[0]) + "▶" + RST : " ";
    const hp = m.hp <= 0 ? RED + "FNT" + RST : GRAY + `${m.hp}/${m.stats.maxhp}` + RST;
    return `${tag}${i+1}) ${m.hp<=0?DIM:""}${m.name}${RST} ${GRAY}L${m.level}${RST} ${hp}`;
  });
  print(parts.join("  "));
}

async function renderTrainerCard(){
  const c = S.camp;
  header();
  rule("TRAINER CARD");
  print("");
  print("  " + BOLD + c.trainer.name + RST + GRAY + "   ₽" + c.trainer.money + "   @ " + RST + (c.location || FAINT+"nowhere — go <location>"+RST));
  print("  " + GRAY + `balls: ${c.trainer.balls.pokeball} poké · ${c.trainer.balls.greatball} great · ${c.trainer.balls.ultraball} ultra   potions: ${c.trainer.potions}   box: ${c.box.length}` + RST);
  print("");
  rule("PARTY");
  if (c.party.length) partyLine(); else print(FAINT + "  (empty)" + RST);
  conseqBlock();
  rule();
  print(GRAY + "  next: " + RST + "go <location>" + GRAY + " · " + RST + "scout" + GRAY + " · " + RST + "encounter [species] [lvl]" + GRAY + " · " + RST + "trainer <name> <spec>" + GRAY + " · " + RST + "heal" + GRAY + " · " + RST + "party");
  print("");
}

async function renderCampBattle(){
  const b = S.camp.battle, foe = b.foe, me = partyActive();
  const [foeArt, meArt] = await Promise.all([fetchSpriteLines(foe), fetchSpriteLines(me)]);
  header();
  rule(b.kind === "trainer"
    ? `TRAINER ${b.name.toUpperCase()}  ·  ${b.queue.length} IN RESERVE`
    : `WILD ${foe.name.toUpperCase()}`);
  print("");
  plate(foe, "FOE");
  printSprite(foeArt, W - CONFIG.SPRITE_COLS - 4);
  printSprite(meArt, 4);
  plate(me, "YOU");
  print("");
  rule("PARTY");
  partyLine();
  rule("MOVES");
  S.camp.party[S.camp.activeIdx].moves.forEach((m,i) => {
    const eff = effectiveness(m.type, foe.types);
    const hint = eff === 0 ? RED+"×0"+RST : eff > 1 ? AMBER+"×"+eff+RST : eff < 1 ? FAINT+"×"+eff+RST : "  ";
    print(`  ${i+1}) ` + pad(typeFg(m.type) + cap(m.name) + RST, 26) +
          GRAY + pad(m.type, 9) + pad("pow "+m.power, 9) + pad("acc "+m.accuracy, 9) + RST + hint);
  });
  if (S.camp.battle.log?.length){
    rule("LOG");
    for (const l of S.camp.battle.log.slice(-7)) print("  " + GRAY + "> " + RST + l);
  }
  rule();
  if (b.mustSwitch){
    print(BOLD + "  Your active member fainted — pick a replacement: " + RST + GRAY + "switch <n>" + RST);
  } else if (b.kind === "wild"){
    const t = S.camp.trainer;
    print(GRAY + "  next: " + RST + "move <1-4>" + GRAY + " · " + RST + "switch <n>" + GRAY + " · " + RST +
          `catch [pokeball|greatball|ultraball]` + GRAY + ` (${t.balls.pokeball}/${t.balls.greatball}/${t.balls.ultraball})` + RST +
          GRAY + " · " + RST + "run" + GRAY + " · " + RST + "use potion <n>" + GRAY + ` (${t.potions})` + RST);
  } else {
    print(GRAY + "  next: " + RST + "move <1-4>" + GRAY + " · " + RST + "switch <n>" + GRAY + " · " + RST + "use potion <n>" + GRAY + ` (${S.camp.trainer.potions})` + RST);
  }
  print("");
}

/* ----- campaign actions ----- */

function needCamp(){
  if (!S.camp){ fail("No journey in progress — journey new <trainer name>"); return true; }
  return false;
}
function needBattle(){
  if (needCamp()) return true;
  if (!S.camp.battle){ fail("No battle in progress."); return true; }
  return false;
}
function noBattlePlease(){
  if (S.camp.battle){ fail("Finish the battle first."); return true; }
  return false;
}

async function actJourney(sub, args){
  if (sub !== "new") {
    if (!S.camp) return fail("journey new <trainer name>");
    S.mode = "campaign";
    await renderCurrentCamp();
    return;
  }
  const name = args.join(" ").trim() || "Red";
  S.mode = "campaign";
  S.camp = {
    trainer: { name, money: CAMP_START.money,
               balls: { ...CAMP_START.balls }, potions: CAMP_START.potions },
    party: [], box: [], activeIdx: 0,
    location: null, battle: null, draft: null,
    counters: { battles: 0, sessions: 1 },
  };
  const gen = ri(0, STARTERS.length/3 - 1) * 3;   // one generation's grass/fire/water trio
  const ids = [STARTERS[gen], STARTERS[gen+1], STARTERS[gen+2]];
  S.camp.draft = await Promise.all(ids.map(id => buildMon(id, 5)));
  await renderStarter();
}

async function actPickStarter(n){
  const i = n - 1;
  if (!S.camp.draft[i]) return fail("pick 1, 2, or 3.");
  S.camp.party = [S.camp.draft[i]];
  S.camp.activeIdx = 0;
  S.camp.draft = null;
  await renderTrainerCard();
}

async function actGo(args){
  if (needCamp() || noBattlePlease()) return;
  const loc = args.join("-").toLowerCase();
  if (!loc) return fail("go <location>  (PokeAPI location names, e.g. viridian-forest, kanto-route-2)");
  try { await getJSON(`https://pokeapi.co/api/v2/location/${loc}`); }
  catch(e){ return fail(`Unknown location "${loc}". PokeAPI location names: viridian-forest, kanto-route-2, mt-moon…`); }
  S.camp.location = loc;
  await renderTrainerCard();
}

async function actScout(){
  if (needCamp() || noBattlePlease()) return;
  if (!S.camp.location) return fail("go <location> first.");
  const enc = await locationEncounters(S.camp.location);
  header();
  rule(`SCOUT — ${S.camp.location.toUpperCase()}`);
  print("");
  if (!enc.length){
    print(FAINT + "  No wild encounters here. The GM can still stage one: encounter <species> <lvl>" + RST);
  } else {
    for (const e of enc.sort((a,b)=>b.chance-a.chance).slice(0, 14))
      print("  " + pad(cap(e.species), 16) + GRAY + `Lv.${e.min}–${e.max}` + RST + "  " + FAINT + Math.min(100, e.chance) + "%" + RST);
  }
  print("");
  rule();
  print(GRAY + "  next: " + RST + "encounter" + GRAY + " (random from this table) · " + RST + "encounter <species> [lvl]");
  print("");
}

async function actEncounter(args){
  if (needCamp() || noBattlePlease()) return;
  if (!S.camp.party.some(m => m.hp > 0)) return fail("Your whole party has fainted — heal first.");
  let foe;
  if (args[0]){
    const level = parseInt(args[1], 10) || Math.max(2, partyActive().level - 2);
    try { foe = await buildMon(args[0].toLowerCase(), level); }
    catch(e){ return fail(`Couldn't build "${args[0]}" — species name or dex number.`); }
  } else {
    if (!S.camp.location) return fail("go <location> first, or encounter <species> <lvl>.");
    const enc = await locationEncounters(S.camp.location);
    if (!enc.length) return fail("Nothing lives here — encounter <species> <lvl> to stage one.");
    const total = enc.reduce((a,e)=>a+e.chance, 0);
    let roll = Math.random() * total, picked = enc[0];
    for (const e of enc){ roll -= e.chance; if (roll <= 0){ picked = e; break; } }
    foe = await buildMon(picked.species, ri(picked.min, picked.max));
  }
  await captureRate(foe);
  if (partyActive().hp <= 0) S.camp.activeIdx = S.camp.party.findIndex(m => m.hp > 0);
  S.camp.counters.battles++;
  S.camp.battle = { kind:"wild", foe, queue:[], name:null, payout:0, mustSwitch:false, log:[] };
  logp(`A wild ${BOLD}${foe.name}${RST} Lv.${foe.level} appeared!`);
  await renderCampBattle();
}

async function actTrainer(args){
  if (needCamp() || noBattlePlease()) return;
  if (!S.camp.party.some(m => m.hp > 0)) return fail("Your whole party has fainted — heal first.");
  if (args.length < 2) return fail('trainer <name> <species:lvl,species:lvl,...>   e.g. trainer Brock geodude:12,onix:14');
  const spec = args[args.length-1];
  const name = args.slice(0, -1).join(" ");
  const team = [];
  for (const part of spec.split(",")){
    const [sp, lv] = part.split(":");
    try { team.push(await buildMon(sp.toLowerCase().trim(), parseInt(lv,10) || 10)); }
    catch(e){ return fail(`Couldn't build "${part}".`); }
  }
  if (!team.length) return fail("Empty team spec.");
  const payout = team.reduce((a,m)=>a+m.level, 0) * 15;
  if (partyActive().hp <= 0) S.camp.activeIdx = S.camp.party.findIndex(m => m.hp > 0);
  S.camp.counters.battles++;
  S.camp.battle = { kind:"trainer", foe: team[0], queue: team.slice(1), name, payout, mustSwitch:false, log:[] };
  logp(`Trainer ${BOLD}${name}${RST} wants to battle! Sent out ${BOLD}${team[0].name}${RST} Lv.${team[0].level}.`);
  await renderCampBattle();
}

async function campFoeDefeated(){
  const b = S.camp.battle;
  logp(`${foeLabel(b.foe)} fainted!`);
  gainExp(partyActive(), b.foe);
  if (b.kind === "trainer" && b.queue.length){
    b.foe = b.queue.shift();
    logp(`${b.name} sent out ${BOLD}${b.foe.name}${RST} Lv.${b.foe.level}.`);
    await renderCampBattle();
    return;
  }
  if (b.kind === "trainer"){
    S.camp.trainer.money += b.payout;
    logp(`${GREEN}Victory!${RST} ${b.name} pays out ${BOLD}₽${b.payout}${RST}.`);
  }
  await endCampBattle();
}

async function endCampBattle(){
  const tail = (S.camp.battle.log || []).slice(-4);
  S.camp.battle = null;
  await renderTrainerCard();
  rulelessTail(tail);
}

function rulelessTail(lines){
  if (!lines.length) return;
  rule("LOG");
  for (const l of lines) print("  " + GRAY + "> " + RST + l);
  print("");
}

async function blackout(){
  const t = S.camp.trainer;
  const lost = Math.floor(t.money / 2);
  t.money -= lost;
  S.camp.party.forEach(m => m.hp = m.stats.maxhp);
  const msg = `${BOLD}${t.name}${RST} blacked out! Rushed to the Pokémon Center — lost ${RED}₽${lost}${RST}.`;
  S.camp.battle = null;
  await renderTrainerCard();
  rulelessTail([msg]);
}

async function campPlayerFaint(){
  const b = S.camp.battle;
  logp(`${BOLD}${partyActive().name}${RST} ${RED}fainted.${RST}`);
  const alive = S.camp.party.map((m,i)=>({m,i})).filter(x => x.m.hp > 0);
  if (!alive.length){ await blackout(); return; }
  if (alive.length === 1){
    S.camp.activeIdx = alive[0].i;
    logp(`Go, ${BOLD}${partyActive().name}${RST}!`);
    await renderCampBattle();
    return;
  }
  b.mustSwitch = true;
  await renderCampBattle();
}

async function campMove(n){
  if (needBattle()) return;
  const b = S.camp.battle;
  if (b.mustSwitch) return fail("Active member is down. switch <n> first.");
  const me = partyActive(), foe = b.foe;
  const mv = me.moves[n-1];
  if (!mv) return fail("move 1-" + me.moves.length + ".");
  const foeMove = enemyChooseMove(foe, me);
  const meFirst = me.stats.spe === foe.stats.spe ? Math.random() < .5 : me.stats.spe > foe.stats.spe;
  const order = meFirst ? [[me,foe,mv,false],[foe,me,foeMove,true]] : [[foe,me,foeMove,true],[me,foe,mv,false]];
  for (const [a,d,m,foeAttacks] of order){
    if (a.hp <= 0) continue;
    strike(a, d, m, foeAttacks);
    if (foe.hp <= 0){ await campFoeDefeated(); return; }
    if (me.hp <= 0){ await campPlayerFaint(); return; }
  }
  await renderCampBattle();
}

async function campSwitch(n){
  if (needBattle()) return;
  const b = S.camp.battle;
  const i = n - 1;
  const target = S.camp.party[i];
  if (!target) return fail("switch 1-" + S.camp.party.length + ".");
  if (i === S.camp.activeIdx) return fail(target.name + " is already out.");
  if (target.hp <= 0) return fail(target.name + " has fainted.");
  S.camp.activeIdx = i;
  logp(`Go, ${BOLD}${target.name}${RST}!`);
  if (b.mustSwitch){
    b.mustSwitch = false;
  } else {
    strike(b.foe, target, enemyChooseMove(b.foe, target), true);
    if (target.hp <= 0){ await campPlayerFaint(); return; }
  }
  await renderCampBattle();
}

async function actCatch(ballArg){
  if (needBattle()) return;
  const b = S.camp.battle;
  if (b.kind !== "wild") return fail("You can't catch a trainer's Pokémon.");
  if (b.mustSwitch) return fail("switch <n> first.");
  const ball = (ballArg || "pokeball").toLowerCase();
  if (!(ball in BALL_MULT)) return fail("catch [pokeball|greatball|ultraball]");
  const t = S.camp.trainer;
  if (t.balls[ball] <= 0) return fail(`No ${ball}s left — buy ${ball} <qty> at a mart.`);
  t.balls[ball]--;
  const foe = b.foe;
  const M = foe.stats.maxhp, H = Math.max(1, foe.hp);
  const a = ((3*M - 2*H) * (foe.captureRate ?? 45) * BALL_MULT[ball]) / (3*M);
  const p = Math.min(1, a / 255);
  if (Math.random() < p){
    foe.hp = Math.max(1, foe.hp);
    let dest;
    if (S.camp.party.length < 6){ S.camp.party.push(foe); dest = "joined the party"; }
    else { S.camp.box.push(foe); dest = "was sent to the box"; }
    const msg = `${GREEN}Gotcha!${RST} ${BOLD}${foe.name}${RST} was caught and ${dest}. ${FAINT}(odds were ${(p*100).toFixed(0)}%)${RST}`;
    S.camp.battle = null;
    await renderTrainerCard();
    rulelessTail([msg]);
    return;
  }
  logp(`The ${ball} shook… ${BOLD}${foe.name}${RST} broke free! ${FAINT}(odds were ${(p*100).toFixed(0)}%)${RST}`);
  strike(foe, partyActive(), enemyChooseMove(foe, partyActive()), true);
  if (partyActive().hp <= 0){ await campPlayerFaint(); return; }
  await renderCampBattle();
}

async function actRun(){
  if (needBattle()) return;
  const b = S.camp.battle;
  if (b.kind !== "wild") return fail("Can't run from a trainer battle.");
  if (b.mustSwitch) return fail("switch <n> first.");
  const me = partyActive(), foe = b.foe;
  const p = Math.min(0.95, Math.max(0.25, 0.4 + 0.4 * (me.stats.spe / foe.stats.spe - 0.5)));
  if (Math.random() < p){
    const msg = "Got away safely.";
    S.camp.battle = null;
    await renderTrainerCard();
    rulelessTail([msg]);
    return;
  }
  logp(`Couldn't escape!`);
  strike(foe, me, enemyChooseMove(foe, me), true);
  if (me.hp <= 0){ await campPlayerFaint(); return; }
  await renderCampBattle();
}

async function actUse(args){
  if (needCamp()) return;
  if ((args[0] || "") !== "potion") return fail("use potion <party slot>");
  const t = S.camp.trainer;
  if (t.potions <= 0) return fail("No potions — buy potion <qty>.");
  const i = parseInt(args[1], 10) - 1;
  const m = S.camp.party[i];
  if (!m) return fail("use potion <1-" + S.camp.party.length + ">");
  if (m.hp <= 0) return fail(m.name + " has fainted — a potion won't help. heal at a center.");
  if (m.hp >= m.stats.maxhp) return fail(m.name + " is already at full HP.");
  t.potions--;
  m.hp = Math.min(m.stats.maxhp, m.hp + 60);
  if (S.camp.battle){
    logp(`Used a potion on ${BOLD}${m.name}${RST} — restored to ${m.hp}/${m.stats.maxhp}.`);
    const foe = S.camp.battle.foe;
    strike(foe, partyActive(), enemyChooseMove(foe, partyActive()), true);
    if (partyActive().hp <= 0){ await campPlayerFaint(); return; }
    await renderCampBattle();
  } else {
    await renderTrainerCard();
    rulelessTail([`Used a potion on ${BOLD}${m.name}${RST} — ${m.hp}/${m.stats.maxhp}.`]);
  }
}

async function actHeal(){
  if (needCamp() || noBattlePlease()) return;
  S.camp.party.forEach(m => m.hp = m.stats.maxhp);
  await renderTrainerCard();
  rulelessTail(["The whole party is fighting fit. " + FAINT + "(Pokémon Center)" + RST]);
}

async function actBuy(args){
  if (needCamp() || noBattlePlease()) return;
  const item = (args[0] || "").toLowerCase();
  const qty = parseInt(args[1], 10) || 1;
  if (!(item in MART)) return fail("buy <pokeball|greatball|ultraball|potion> <qty>");
  const cost = MART[item] * qty;
  const t = S.camp.trainer;
  if (t.money < cost) return fail(`That's ₽${cost} — you have ₽${t.money}.`);
  t.money -= cost;
  if (item === "potion") t.potions += qty; else t.balls[item] += qty;
  await renderTrainerCard();
  rulelessTail([`Bought ${qty} ${item}${qty>1?"s":""} for ₽${cost}.`]);
}

async function actParty(args){
  if (needCamp()) return;
  if (args[0] === "swap"){
    const a = parseInt(args[1],10)-1, b = parseInt(args[2],10)-1;
    if (!S.camp.party[a] || !S.camp.party[b]) return fail("party swap <a> <b>");
    [S.camp.party[a], S.camp.party[b]] = [S.camp.party[b], S.camp.party[a]];
    if (S.camp.activeIdx === a) S.camp.activeIdx = b;
    else if (S.camp.activeIdx === b) S.camp.activeIdx = a;
  }
  if (S.camp.battle) await renderCampBattle(); else await renderTrainerCard();
}

async function actDeposit(n){
  if (needCamp() || noBattlePlease()) return;
  const i = n - 1;
  const m = S.camp.party[i];
  if (!m) return fail("deposit <party slot>");
  if (S.camp.party.length === 1) return fail("Can't deposit your last party member.");
  S.camp.party.splice(i, 1);
  S.camp.box.push(m);
  if (S.camp.activeIdx >= S.camp.party.length) S.camp.activeIdx = 0;
  await renderTrainerCard();
  rulelessTail([`${m.name} was sent to the box.`]);
}

async function actWithdraw(n){
  if (needCamp() || noBattlePlease()) return;
  const i = n - 1;
  const m = S.camp.box[i];
  if (!m) return fail(`withdraw <box slot 1-${S.camp.box.length}>` + (S.camp.box.length ? "" : "  (box is empty)"));
  if (S.camp.party.length >= 6) return fail("Party is full — deposit someone first.");
  S.camp.box.splice(i, 1);
  S.camp.party.push(m);
  await renderTrainerCard();
  rulelessTail([`${m.name} joined the party.`]);
}

async function actBox(){
  if (needCamp()) return;
  header();
  rule("BOX");
  print("");
  if (!S.camp.box.length) print(FAINT + "  (empty)" + RST);
  S.camp.box.forEach((m,i) => print(`  ${i+1}) ` + pad(m.name, 16) + GRAY + `Lv.${m.level}  ` + RST + typeLabel(m.types)));
  print("");
  rule();
  print(GRAY + "  next: " + RST + "withdraw <n>" + GRAY + " · " + RST + "status");
  print("");
}

/* ----- GM persistence: journal + memory namespaces ----- */

function actJournal(args){
  const file = path.join(DIR, "journal.md");
  if (!args.length){
    const txt = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").slice(-20) : [];
    header(); rule("JOURNAL"); print("");
    if (!txt.length) print(FAINT + "  (empty)" + RST);
    for (const l of txt) print("  " + l);
    print("");
    return;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const where = S.camp?.location || (S.mode === "arcade" ? "gauntlet" : "—");
  fs.appendFileSync(file, `- [${where}] ${args.join(" ")}\n`);
  print(""); print(GRAY + "  journal updated." + RST); print("");
}

function memFile(ns){ return path.join(DIR, "memory", ns.replace(/[^a-z0-9_-]/gi, "") + ".json"); }

function actMemory(args){
  const [op, ns, key, ...rest] = args;
  if (op === "list"){
    const dir = path.join(DIR, "memory");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith(".json")) : [];
    print(""); print("  namespaces: " + (files.map(f=>f.replace(".json","")).join(", ") || "(none)")); print("");
    return;
  }
  if (!ns) return fail("memory <set|get|del|list> <namespace> [key] [value]");
  const file = memFile(ns);
  const data = loadJSON(file, {});
  if (op === "get"){
    print(""); print(JSON.stringify(key ? (data[key] ?? null) : data, null, 2).split("\n").map(l=>"  "+l).join("\n")); print("");
    return;
  }
  if (op === "set"){
    if (!key || !rest.length) return fail("memory set <ns> <key> <value…>");
    const raw = rest.join(" ");
    let val; try { val = JSON.parse(raw); } catch(e){ val = raw; }
    data[key] = val;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    saveJSON(file, data);
    print(""); print(GRAY + `  ${ns}.${key} saved.` + RST); print("");
    return;
  }
  if (op === "del"){
    delete data[key];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    saveJSON(file, data);
    print(""); print(GRAY + `  ${ns}.${key} deleted.` + RST); print("");
    return;
  }
  fail("memory <set|get|del|list> …");
}


/* ----- consequences: the world pushes back ----- */
/* Staged events with triggers the engine can evaluate. Due consequences
   surface automatically on the trainer card — the GM fires them into the story. */

const CONSEQ_NS = "consequences";

function conseqAll(){ return loadJSON(memFile(CONSEQ_NS), {}); }
function conseqSave(data){
  fs.mkdirSync(path.dirname(memFile(CONSEQ_NS)), { recursive: true });
  saveJSON(memFile(CONSEQ_NS), data);
}

function conseqDue(){
  if (!S.camp) return [];
  const c = S.camp.counters || { battles:0, sessions:0 };
  const due = [];
  for (const [key, q] of Object.entries(conseqAll())){
    if (q.at_location && q.at_location === S.camp.location) { due.push([key, q]); continue; }
    if (q.after_battles != null && c.battles - (q.base?.battles ?? 0) >= q.after_battles) { due.push([key, q]); continue; }
    if (q.after_sessions != null && c.sessions - (q.base?.sessions ?? 0) >= q.after_sessions) { due.push([key, q]); continue; }
  }
  return due;
}

function conseqBlock(){
  const due = conseqDue();
  if (!due.length) return;
  rule("WORLD");
  for (const [key, q] of due)
    print("  " + AMBER + "⚠ " + RST + BOLD + key + RST + GRAY + " — " + RST + (q.what || ""));
  print("  " + FAINT + "fire into the story: consequence fire <key>" + RST);
}

function actConsequence(args){
  const [op, key, ...rest] = args;
  if (!S.camp) { fail("No journey in progress."); return; }
  const data = conseqAll();
  if (op === "add"){
    if (!key || !rest.length) return fail('consequence add <key> {"what":"...","at_location"?|"after_battles"?|"after_sessions"?}');
    let q; try { q = JSON.parse(rest.join(" ")); } catch(e){ q = { what: rest.join(" ") }; }
    q.base = { ...S.camp.counters };
    data[key] = q;
    conseqSave(data);
    print(""); print(GRAY + `  consequence "${key}" staged.` + RST); print("");
    return;
  }
  if (op === "list"){
    print(""); 
    const due = new Set(conseqDue().map(([k]) => k));
    const keys = Object.keys(data);
    if (!keys.length) print(FAINT + "  (nothing staged)" + RST);
    for (const k of keys){
      const q = data[k];
      const trig = q.at_location ? "at " + q.at_location
                 : q.after_battles != null ? `after ${q.after_battles} battles`
                 : q.after_sessions != null ? `after ${q.after_sessions} sessions`
                 : "manual";
      print("  " + (due.has(k) ? AMBER + "⚠ DUE " + RST : FAINT + "  …   " + RST) + BOLD + k + RST + GRAY + ` [${trig}] ` + RST + (q.what || ""));
    }
    print("");
    return;
  }
  if (op === "due"){
    const due = conseqDue();
    print("");
    if (!due.length) print(FAINT + "  (nothing due)" + RST);
    for (const [k, q] of due) print("  " + AMBER + "⚠ " + RST + BOLD + k + RST + GRAY + " — " + RST + (q.what || ""));
    print("");
    return;
  }
  if (op === "fire"){
    const q = data[key];
    if (!q) return fail(`No staged consequence "${key}".`);
    delete data[key];
    conseqSave(data);
    const where = S.camp?.location || "—";
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, "journal.md"), `- [${where}] CONSEQUENCE FIRED — ${key}: ${q.what || ""}\n`);
    print(""); print("  " + AMBER + "⚠ " + RST + BOLD + key + RST + " fired and journaled: " + (q.what || "")); print("");
    return;
  }
  fail("consequence <add|list|due|fire> …");
}

function actTick(){
  if (!S.camp) { fail("No journey in progress."); return; }
  S.camp.counters.sessions++;
  print(""); print(GRAY + `  Session ${S.camp.counters.sessions}. The world moved while you were away.` + RST);
  const due = conseqDue();
  if (due.length){
    rule("WORLD");
    for (const [k, q] of due) print("  " + AMBER + "⚠ " + RST + BOLD + k + RST + GRAY + " — " + RST + (q.what || ""));
  } else {
    print(FAINT + "  Nothing has come due — yet." + RST);
  }
  print("");
}

async function renderCurrentCamp(){
  if (!S.camp) { await renderCurrent(); return; }
  if (S.camp.draft) await renderStarter();
  else if (S.camp.battle) await renderCampBattle();
  else await renderTrainerCard();
}

/* ---------------- DISPATCH ---------------- */

async function dispatch(verb, args){
  switch (verb){
    /* arcade */
    case "start": S.mode = "arcade"; await actStart(); break;
    case "reward": await actReward(args[0], parseInt(args[1],10)); break;
    /* campaign */
    case "journey": await actJourney(args[0], args.slice(1)); break;
    case "go": await actGo(args); break;
    case "scout": await actScout(); break;
    case "encounter": await actEncounter(args); break;
    case "trainer": await actTrainer(args); break;
    case "catch": await actCatch(args[0]); break;
    case "run": await actRun(); break;
    case "use": await actUse(args); break;
    case "heal": await actHeal(); break;
    case "buy": await actBuy(args); break;
    case "party": await actParty(args); break;
    case "deposit": await actDeposit(parseInt(args[0],10)); break;
    case "withdraw": await actWithdraw(parseInt(args[0],10)); break;
    case "box": await actBox(); break;
    case "journal": actJournal(args); break;
    case "memory": actMemory(args); break;
    case "consequence": actConsequence(args); break;
    case "tick": actTick(); break;
    /* shared — routed by active context */
    case "pick":
      if (S.camp?.draft) await actPickStarter(parseInt(args[0],10));
      else await actPick(parseInt(args[0],10));
      break;
    case "move": case "m":
      if (S.camp?.battle) await campMove(parseInt(args[0],10));
      else await actMove(parseInt(args[0],10));
      break;
    case "switch": case "s":
      if (S.camp?.battle) await campSwitch(parseInt(args[0],10));
      else await actSwitch(parseInt(args[0],10));
      break;
    case "status": case undefined:
      if (S.mode === "campaign") await renderCurrentCamp();
      else await renderCurrent();
      break;
    case "help":
      print("");
      print("  arcade:   start · pick <n> · move <n> · switch <n> · reward <restore|train <n>|recruit [slot]>");
      print("  journey:  journey new <name> · go <location> · scout · encounter [species] [lvl]");
      print("            trainer <name> <sp:lvl,…> · catch [ball] · run · use potion <n>");
      print("            heal · buy <item> <qty> · party [swap a b] · box · deposit <n> · withdraw <n>");
      print("  gm:       journal [text] · memory <set|get|del|list> <ns> [key] [value]");
      print("            consequence <add|list|due|fire> · tick (advance a session)");
      print("");
      break;
    default: fail("Unknown command: " + verb + ". Try: help");
  }
  persist();
  flushOut();
}

/* ---------------- ENTRY ---------------- */

const argv = process.argv.slice(2);
if (argv.length > 0){
  dispatch(argv[0], argv.slice(1)).catch(e => { fail(e.message); flushOut(); process.exit(1); });
} else {
  // interactive REPL with the same verbs
  (async () => {
    await renderCurrent(); flushOut();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "gauntlet> " });
    rl.prompt();
    rl.on("line", async line => {
      const [verb, ...args] = line.trim().split(/\s+/);
      if (verb === "quit" || verb === "exit"){ rl.close(); return; }
      try { await dispatch(verb || "status", args); } catch(e){ fail(e.message); flushOut(); }
      rl.prompt();
    });
    rl.on("close", () => process.exit(0));
  })();
}
