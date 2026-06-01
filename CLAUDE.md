# GAUNTLET

A Pokémon game engine played inside a Claude Code session. Zero dependencies, Node 18+. All data — stats, moves, sprites, locations, encounter tables, catch rates — pulled live from https://pokeapi.co. Nothing non-Pokémon ships with this project.

Three surfaces on one ruleset:

- **Arcade** (`/gauntlet`) — the endless draft battler. Roguelike streak game; rules below.
- **Journey, web** (`npm start` → http://localhost:7779) — the web face on the Claude Code brain, multi-tenant. `server.js` (zero deps) gives every visitor a cookie identity and an isolated world under `campaigns/<uid>/` (own `.gauntlet` state + a `game.js` symlink). Player actions proxy to the engine; GM beats run `claude -p --bare` from the visitor's directory with the protocol injected from `gm-prompt.md` and tools scoped to `Bash(node game.js:*)` + Read — so the GM is the real Claude Code agent acting on that visitor's world with its own tool calls, streamed live to the UI (⚙ activity lines, then serif narration). Per-user session continuity via `--resume`.

  **Artifact test build** (`artifact/gauntlet-journey.html`) — the journey as a claude.ai artifact for instant playtesting with zero hosting. Artifact CSP blocks external fetches, so it ships self-contained: an embedded Kanto opening slice (16 species with real stats/moves/capture rates, sprites as data URIs, 5 locations with canon-ish encounter tables — Pallet Town through Mt. Moon) built from live PokeAPI at pack time. GM runs over the keyless artifact API with the directive protocol (constrained to pack content); saves via `window.storage`. Same engine math, same consequence loop. It's the demo unit — the hosted server below is the product. Rebuild the pack by re-running the pack-builder against PokeAPI with a different species/location set.

  **Hosting for non-Claude-Code users:** the operator's `ANTHROPIC_API_KEY` powers all GM beats (bare mode skips OAuth by design). Cost controls built in: `GAUNTLET_BEATS_PER_HOUR` per visitor (default 30) and `GAUNTLET_MAX_CONCURRENT` global GM beats (default 2); over-limit visitors keep full engine play, narrator-free. Deploy with the included Dockerfile (`docker build -t gauntlet . && docker run -p 7779:7779 -e ANTHROPIC_API_KEY=sk-ant-… -v gauntlet-worlds:/app/campaigns gauntlet`) or any box with Node 18+ and `npm i -g @anthropic-ai/claude-code`. The cookie is the only identity — put real auth in front of it before opening to strangers. Note: Agent SDK / `claude -p` usage on subscription plans draws from a separate monthly credit starting June 15, 2026; hosted deployments should run on an API key. Local solo play is the same server with one cookie.
- **Journey, CLI** (`/journey`) — a narrated campaign. Claude is the Game Master (protocol in `.claude/skills/pokemon-gm/SKILL.md`); the engine adjudicates every battle, catch, and purchase. Trainer card, party of 6, box, money, balls, potions. Wild encounters come from PokeAPI's real location data — `scout` on viridian-forest returns the actual Viridian Forest table with canon level ranges. Trainer and gym battles are staged by the GM (`trainer Brock geodude:12,onix:14`). Catching uses real species capture rates with the Gen-style formula. Loss is a blackout (party healed, half money), never permadeath. Story state — NPCs, plots, badges, facts — persists via `memory` namespaces and `journal`. Staged `consequence` events give the world initiative: the engine tracks location, battle-count, and session triggers, surfaces due events on the trainer card, and the GM fires them into the story. All on disk under `.gauntlet/`.

The GM loop, both modes: **CONTEXT → DECIDE → EXECUTE (engine) → PERSIST → NARRATE.** The engine owns all numbers; Claude never rolls or invents mechanics.

Every player decision is one CLI command. State persists in `.gauntlet/state.json`, so each command is stateless-in, full-frame-out: it resolves the action and prints the complete rendered screen.

## Rendering: two channels

When stdout is captured (a Claude Code tool call), the game emits **two frames per command**:

- **stdout** — a compact, escape-free frame (~3–5 KB). Sprites are luminance-shaded Unicode pixel art (`░▒▓█`). This is what the agent reads and relays; it renders cleanly in the transcript.
- **/dev/tty** — the full 24-bit ANSI color frame, painted directly onto the user's terminal, bypassing tool-output capture. Half-block sprites in true color.

When stdout is a TTY (the user runs the game directly), only the color frame is printed. `GAUNTLET_TTY=0` disables the /dev/tty channel; `NO_COLOR=1` forces plain everywhere. Never pipe the color frame into the transcript — raw ANSI does not render there and bloats context.

## How Claude plays referee

When the user wants to play (`/gauntlet`, "let's play", a move instruction):

1. Run `node game.js status` to resume, or `node game.js start` for a fresh run.
2. **Show every command's stdout verbatim, in a fenced code block.** The frame is the game — sprites, HP bars, matchup hints, log. Never summarize it, never re-draw it in your own words, never invent results. (The full-color version was already painted to the user's terminal via /dev/tty.)
3. **One command per player decision.** The player decides; you translate. "use the water move" → find it on the MOVES list → `node game.js move 3`. "swap to slot 2" → `node game.js switch 2`. "take the recruit over slot 1" → `node game.js reward recruit 1`.
4. **Never decide for the player.** Draft picks, moves, switches, and rewards are theirs. If an instruction is ambiguous ("attack"), ask which move — don't pick one.
5. Strategy reads only when asked. The frame shows type matchup multipliers (×2, ×0.5, ×0) next to each move; use those plus the type chart when the player wants advice.
6. After the frame, a one-line prompt of legal next commands is enough commentary.

## Commands

```
# arcade
node game.js start                  new run → draft screen
node game.js reward <restore|train <n>|recruit [slot]>

# journey (campaign)
node game.js journey new <name>     new campaign → starter trio pick
node game.js go <location>          travel (PokeAPI location names: viridian-forest, kanto-route-2, mt-moon)
node game.js scout                  canon encounter table for the current location
node game.js encounter [sp] [lvl]   wild battle — random from table, or GM-staged species/level
node game.js trainer <name> <sp:lvl,sp:lvl,…>   staged trainer/gym battle (payout on win)
node game.js catch [ball]           pokeball | greatball | ultraball — Gen-style odds, real capture rates
node game.js run                    flee a wild battle (speed-based)
node game.js use potion <n>         +60 HP; costs the turn in battle
node game.js heal                   Pokémon Center — full party
node game.js buy <item> <qty>       pokeball 200 · greatball 600 · ultraball 1200 · potion 300
node game.js party [swap a b] · box · deposit <n> · withdraw <n>
node game.js journal [text]         append/read the session log
node game.js memory <set|get|del|list> <ns> [key] [value]   GM story state (npcs, plots, badges, facts)
node game.js consequence add <key> <json>   stage a future event — triggers: at_location, after_battles, after_sessions, or manual
node game.js consequence <list|due|fire <key>>   due events auto-surface on the trainer card; fire journals + clears
node game.js tick                   advance the session clock; prints what came due (GM runs this at session start)

# shared
node game.js pick <1-3>             starter/draft choice (routed by context)
node game.js move <1-4> · switch <n> · status · help
node game.js                        interactive REPL (same verbs)
```

Both modes coexist in `.gauntlet/state.json`; arcade resets never touch the campaign. Wild exp goes to the active member on KO (cubic curve, real base-experience values); trainer wins also pay out money. Legendary/boss pools, BST compensation, and battle math are shared across modes.

## Rules of the run

- Draft 1 of 3 random pulls from the full dex (IDs 1–1025): real base stats, four real damaging moves from the actual learnset.
- Battles are turn-based: full 18-type chart, STAB 1.5×, crits 1/16 at 1.5×, physical/special split, accuracy rolls, speed-ordered turns.
- BST level compensation (`bstScale`): weak mons fight above their nominal level, strong ones below, clamped to ×0.85–1.25. The whole dex is draftable; the pick is about typing, stat shape, and movepool, not raw totals.
- Team max 3. Each win: +2 levels and a 20% passive heal; fainted members stay down unless restored.
- Each win offers a random **two of the three** rewards (recruit / restore / train) — claim one. Restore is full heal + revive; train is **additive** +10% of base per claim (linear, not compounding); recruit replacement is permanent.
- Enemy stats carry a compounding ×1.02-per-round multiplier on top of level scaling, so every run mathematically ends.
- Every 5th round is a legendary from a curated pool at +4 levels. Legendaries never appear in the regular wild/draft/recruit pool.
- Wipe ends the run. Streak is the score; best persists across runs.

## Architecture (game.js, single file)

Top-to-bottom: `CONFIG` (every tunable) → static data (`TYPE_CHART`, `TYPE_COLORS`, `BOSS_IDS`) → ANSI helpers → persistence (`.gauntlet/state.json` + `.gauntlet/cache.json`; large `/pokemon/` responses stay memory-only, move data and rendered sprite art persist) → PNG decoder (handles 1/2/4/8-bit palette, grayscale, RGB, RGBA, non-interlaced — gen-5 sprites are 4-bit palette) → half-block sprite renderer (`▀` with 24-bit fg/bg, crops to opaque bounding box) → builders → battle math → screen renderers → action handlers → dispatch → CLI/REPL entry.

`NO_COLOR=1` strips all ANSI if a context can't render it.

## Testing

```
python3 test/drive.py [n]    n full automated runs against live PokeAPI
```

The driver drafts on BST, scores moves with the phys/spec split and type chart, handles forced switches, restores when team damage exceeds 35%, and otherwise trains. Runs are capped at 40 rounds. Reference distribution at time of writing: optimal-bot runs reach round ~14, with occasional early deaths on trap drafts. Run it after any change to battle math, the reward economy, state transitions, or the dispatch layer. A structural failure (stuck screen, bad state file, crash) fails loudly; low scores alone are variance. The economy has two known failure modes to watch when retuning: unlimited restore makes runs near-infinite, and compounding train outgrows linear enemy scaling — the 2-of-3 offering, additive train, and ×1.02 foe ramp exist to close them.

## Provenance

The journey mode's harness pattern — persistent state on disk, a deterministic mechanics layer the model calls instead of improvising rules, persist-before-narrate, memory namespaces, action routing via skills — is adapted from Sstobo/Claude-Code-Game-Master. No code or content was taken from it: that project is D&D-based, and everything here is Pokémon-only, grounded in PokeAPI.

## Extension backlog

- Evolution at level thresholds via `pokemon-species` → `evolution-chain` — biggest campaign-mode payoff.
- Move learning on level-up (`pokemon` move `version_group_details` carry `level_learned_at`).
- Status moves and effects (burn, paralysis, stat stages) — `buildMoves` currently filters `damage_class === "status"`.
- More items: revives, super/hyper potions, repels; held items.
- Day/night and time-gated encounters; a `world tick` that advances staged consequences between sessions.
- Seeded runs for arcade; daily seed from the date.
- Animated frames — emit two frames per strike (impact flash) since terminal scrollback preserves them as a flipbook.
