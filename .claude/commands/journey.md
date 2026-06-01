---
description: Start or resume a narrated Pokémon journey (campaign mode)
---

Load the pokemon-gm skill and run the journey.

- No campaign on disk → `node game.js journey new <name>` (ask their trainer name first if not given).
- Campaign exists → `node game.js status`, `node game.js memory get npcs`, `node game.js journal` → two-sentence recap → continue where they stood.

Protocol: engine for all mechanics, frames verbatim in code blocks, persist story via journal/memory before narrating.

Player's opening instruction, if any: $ARGUMENTS
