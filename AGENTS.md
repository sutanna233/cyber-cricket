# Repository Guidelines

## Project Structure & Module Organization

This dependency-free JavaScript/Canvas auto-battler uses classic IIFEs sharing `globalThis.CC`.

- `js/`: fighters, deterministic combat/AI, rendering, placement, UI, and recording.
- `index.html`, `account.html`, `sim-watch.html`, `replay-export.html`: gameplay, accounts, simulation workbench, and administrator recording.
- `server.js`, `lib/`: allowlisted static hosting, accounts, headless simulation, and replay validation.
- `assets/`: committed images/audio; `docs/`: validation and balance results; `deploy/`: production setup.

## Build, Test, and Development Commands

Use Node.js 18+; no dependency installation or build is required.

- `node server.js`: start `http://127.0.0.1:8130`; occupied ports advance automatically.
- `node server.js --port 8131 --mode view`: inspect spectator permissions.
- `node --check js/engine.js`: syntax-check changed modules.

Local, intentionally ignored checks live in `tools/_aicheck/`: run `expanded-skills-regression.js`, `modes-regression.js`, `matrix.js`, and `audio-regression.js` with Node. `recording-regression.js` requires an isolated test server. No test framework or coverage threshold is committed. Record seeds, sample sizes, and verification limits in `docs/AI-VALIDATION.md` and `docs/BALANCE.md`.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, camelCase, and uppercase constants. Preserve script dependency order; no formatter/linter is configured. Combat advances at 60 ticks/second using seeded RNG; derive displayed time from `tick / 60`. Keep simulation independent of DOM/audio. Preserve cast/projectile target IDs, normalized dash vectors, and damage-free defensive dodges.

## Gameplay & Testing Guidelines

Reply in Chinese. Preserve quiet audio defaults, concurrency limits, and persisted volume/mute controls. Ranged positioning follows damaging-skill reach.

Keep only `tomori`, `xujiayin`, `zhangxuefeng`, and `tiansuluo`. Preserve supplied transparent PNGs unchanged. Retain Tomori’s collection/stone skills plus independent flying kick. Xu’s 空城计 decoy inherits ownership and cannot determine victory. Zhang visibly runs, builds at most five pace stacks, and leaves **15-second** tracks; snacks grant two starting stacks. Tiansuluo uses 泡泡快递、泡泡陷阱、连锁啵啵.

Use one shared, reusable deployment pool. Bench placement replaces occupied slots; slot movement swaps instances. Support duplicates in saves and random fill. Manual start is default for players; optional auto-start waits five seconds and pauses during dragging. Free brawl treats each original participant as an independent team. Verify side-swapped balance, replay consistency, drag/replace/remove, pause, and real browser output.

## Commit, Security & Configuration

Track changes in GitHub issues, commit focused Chinese summaries, and push completed work. Include behavior, validation, and screenshots; close resolved issues.

Ignore account data and `.env*`; local `.env` never overrides explicit environment variables. Administrator recording requires server authorization for both page and API; export real WebM plus replay JSON. Preserve the explicitly requested fixed hidden administrator `Haleksius`, authenticated through its fixed scrypt verifier and omitted from account lists. Never print credentials in reports.
