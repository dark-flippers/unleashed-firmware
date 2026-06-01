---
description: Play GAUNTLET — the endless Pokémon draft battler — in this session
---

Start or resume a GAUNTLET run and referee it for the player.

Protocol (full version in CLAUDE.md):
- Run `node game.js status` to resume; `node game.js start` if no run exists or the player asks for a fresh one.
- Show every command's output verbatim — the ANSI frame is the game. Never summarize or re-draw it.
- One command per player decision. Translate natural language to the exact command (`move <n>`, `switch <n>`, `pick <n>`, `reward ...`).
- Never choose for the player. Ambiguous instruction → ask.
- Strategy reads only on request.

Player's opening instruction, if any: $ARGUMENTS
