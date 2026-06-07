#!/usr/bin/env node
"use strict";

/* =====================================================================
   GAUNTLET web server — hosted, multi-tenant.
   Visitors get the full agentic GM without Claude Code of their own:
   the operator's machine runs `claude -p` (bare mode, ANTHROPIC_API_KEY).

   - Each visitor gets a cookie uid → campaigns/<uid>/ with its own
     .gauntlet state and a game.js symlink, so both the player's UI and
     the GM agent act on the same per-user world.
   - GM beats: claude -p --bare, GM protocol injected from gm-prompt.md,
     tools scoped to Bash(node game.js:*) + Read, cwd = the user's dir.
     Session continuity per user via --resume.
   - Cost control: per-user beats/hour + a global concurrency gate.

   Single-user local play works identically: same server, one cookie.

   Env:
     ANTHROPIC_API_KEY       required for the GM on a headless server
                             (a logged-in Claude Code also works locally)
     PORT                    default 7779
     GAUNTLET_CLAUDE_BIN     default "claude"
     GAUNTLET_BEATS_PER_HOUR default 30 (per user)
     GAUNTLET_MAX_CONCURRENT default 2 (global GM beats)
     GAUNTLET_GM_TIMEOUT     default 180000 ms
   ===================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const ROOT = __dirname;
const CAMPAIGNS = path.join(ROOT, "campaigns");
const PORT = process.env.PORT || 7779;
const CLAUDE_BIN = process.env.GAUNTLET_CLAUDE_BIN || "claude";
const GM_TOOLS = process.env.GAUNTLET_GM_TOOLS || "Read,Bash(node game.js:*)";
const GM_TIMEOUT = parseInt(process.env.GAUNTLET_GM_TIMEOUT || "180000", 10);
const BEATS_PER_HOUR = parseInt(process.env.GAUNTLET_BEATS_PER_HOUR || "30", 10);
const MAX_CONCURRENT = parseInt(process.env.GAUNTLET_MAX_CONCURRENT || "2", 10);

let claudeOK = null;
let gmPrompt = "";
try { gmPrompt = fs.readFileSync(path.join(ROOT, "gm-prompt.md"), "utf8"); } catch(e){}

/* ---------------- tenancy ---------------- */

function userDir(uid){
  const dir = path.join(CAMPAIGNS, uid);
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
    try { fs.symlinkSync(path.join(ROOT, "game.js"), path.join(dir, "game.js")); }
    catch(e){ fs.copyFileSync(path.join(ROOT, "game.js"), path.join(dir, "game.js")); }
  }
  return dir;
}

function getUID(req, res){
  const m = (req.headers.cookie || "").match(/gauntlet_uid=([a-f0-9]{32})/);
  if (m) return m[1];
  const uid = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `gauntlet_uid=${uid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  return uid;
}

/* ---------------- helpers ---------------- */

function readJSON(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e){ return fallback; }
}
function send(res, code, body, type="application/json"){
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => { b += c; if (b.length > 64e3) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch(e){ reject(e); } });
  });
}

function fullState(dir){
  const g = path.join(dir, ".gauntlet");
  const state = readJSON(path.join(g, "state.json"), null);
  const memory = {};
  const memDir = path.join(g, "memory");
  if (fs.existsSync(memDir))
    for (const f of fs.readdirSync(memDir).filter(f => f.endsWith(".json")))
      memory[f.replace(".json","")] = readJSON(path.join(memDir, f), {});
  let journal = [];
  const jf = path.join(g, "journal.md");
  if (fs.existsSync(jf)) journal = fs.readFileSync(jf, "utf8").trim().split("\n").slice(-30);
  return { state, memory, journal, gm: { available: claudeOK } };
}

/* ---------------- engine proxy ---------------- */

const SAFE_VERBS = new Set([
  "journey","pick","go","scout","encounter","trainer","catch","run","use","heal",
  "buy","party","box","deposit","withdraw","journal","memory","consequence","tick",
  "move","switch","status","start","reward","help",
]);

function runEngine(dir, verb, args){
  const safeArgs = (args||[]).map(a => String(a).slice(0, 300));
  return new Promise(resolve => {
    execFile("node", ["game.js", verb, ...safeArgs],
      { cwd: dir, timeout: 120000, env: { ...process.env, NO_COLOR: "1", GAUNTLET_TTY: "0" } },
      (err, stdout, stderr) => resolve({ ok: !err, output: stdout || "", error: err ? (stderr || err.message) : null }));
  });
}

/* ---------------- GM beats: limits + queue ---------------- */

const beatLog = new Map();      // uid → [timestamps]
let inFlight = 0;
const waiting = [];

function rateOK(uid){
  const now = Date.now();
  const list = (beatLog.get(uid) || []).filter(t => now - t < 3600e3);
  beatLog.set(uid, list);
  if (list.length >= BEATS_PER_HOUR) return false;
  list.push(now);
  return true;
}
function acquire(){
  if (inFlight < MAX_CONCURRENT){ inFlight++; return Promise.resolve(); }
  return new Promise(r => waiting.push(r));
}
function release(){
  inFlight--;
  const next = waiting.shift();
  if (next){ inFlight++; next(); }
}

function beatPrompt(text, events){
  return [
    events?.length ? "[ENGINE EVENTS — what just happened mechanically]\n" + events.slice(0,20).map(e=>String(e).slice(0,300)).join("\n") + "\n" : "",
    "[PLAYER]\n" + String(text || "(no words — react to the engine events)").slice(0, 2000),
    "",
    "Act now per your protocol, then output only the narration.",
  ].join("\n");
}

async function gmBeat(res, dir, uid, body){
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const emit = obj => res.write(JSON.stringify(obj) + "\n");
  const finish = () => { emit({ type:"done" }); res.end(); };

  if (!claudeOK){ emit({ type:"error", message:"GM offline on this server — engine-only." }); return finish(); }
  if (!rateOK(uid)){ emit({ type:"error", message:`GM beat limit reached (${BEATS_PER_HOUR}/hour). The engine still works — keep playing, the narrator returns shortly.` }); return finish(); }

  await acquire();
  const sessFile = path.join(dir, ".gauntlet", "gm-session");
  const sid = fs.existsSync(sessFile) ? fs.readFileSync(sessFile, "utf8").trim() : null;
  const args = ["--bare", "-p", beatPrompt(body.text, body.events),
                "--append-system-prompt", gmPrompt,
                "--output-format", "stream-json", "--verbose",
                "--allowedTools", GM_TOOLS];
  if (sid) args.push("--resume", sid);

  const child = spawn(CLAUDE_BIN, args, { cwd: dir, env: process.env });
  const killer = setTimeout(() => child.kill("SIGKILL"), GM_TIMEOUT);
  let buf = "", gotResult = false, errTail = "";

  child.stdout.on("data", chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch(e){ continue; }
      if (ev.session_id){
        try { fs.mkdirSync(path.dirname(sessFile), { recursive: true }); fs.writeFileSync(sessFile, ev.session_id); } catch(e){}
      }
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)){
        for (const block of ev.message.content)
          if (block.type === "tool_use"){
            const what = block.name === "Bash" ? (block.input?.command || "") : block.name + " " + (block.input?.file_path || "");
            emit({ type:"tool", text: what.slice(0, 120) });
          }
      }
      if (ev.type === "result"){
        gotResult = true;
        if (ev.subtype === "success" && ev.result) emit({ type:"narration", text: String(ev.result).trim() });
        else emit({ type:"error", message: "GM beat ended without narration (" + (ev.subtype||"unknown") + ")." });
      }
    }
  });
  child.stderr.on("data", d => { errTail = (errTail + d).slice(-400); });
  child.on("close", code => {
    clearTimeout(killer);
    release();
    if (!gotResult){
      if (sid){ try { fs.unlinkSync(sessFile); } catch(e){} }
      emit({ type:"error", message: `GM exited (${code}) without a result${sid ? "; session reset — try again" : ""}. ${errTail.trim()}`.trim() });
    }
    finish();
  });
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    const uid = getUID(req, res);
    const dir = userDir(uid);
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "index.html")), "text/html; charset=utf-8");
    if (req.method === "GET" && req.url === "/state")
      return send(res, 200, fullState(dir));
    if (req.method === "POST" && req.url === "/cmd"){
      const body = await readBody(req);
      if (!SAFE_VERBS.has(body.verb)) return send(res, 400, { ok:false, error:"unknown verb" });
      const r = await runEngine(dir, body.verb, body.args);
      return send(res, 200, { ...r, ...fullState(dir) });
    }
    if (req.method === "POST" && req.url === "/gm"){
      const body = await readBody(req);
      return gmBeat(res, dir, uid, body);
    }
    send(res, 404, { error: "not found" });
  } catch(e){ send(res, 500, { error: e.message }); }
});

execFile(CLAUDE_BIN, ["--version"], { timeout: 15000, env: process.env }, err => {
  claudeOK = !err && !!gmPrompt;
  fs.mkdirSync(CAMPAIGNS, { recursive: true });
  server.listen(PORT, () => {
    console.log(`GAUNTLET web → http://localhost:${PORT}`);
    console.log(claudeOK
      ? `GM online via ${CLAUDE_BIN} --bare (tools: ${GM_TOOLS}; ${BEATS_PER_HOUR} beats/user/hr; ${MAX_CONCURRENT} concurrent)`
      : `GM OFFLINE — '${CLAUDE_BIN}' missing${gmPrompt ? "" : " / gm-prompt.md missing"}. Engine-only mode.`);
    if (claudeOK && !process.env.ANTHROPIC_API_KEY)
      console.log("note: bare mode needs ANTHROPIC_API_KEY on headless servers; a local Claude Code login won't be read.");
  });
});
