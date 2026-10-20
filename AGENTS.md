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

Reply in Chinese. Preserve quiet audio defaults, concurrency limits, and persisted volume/mute controls. Recordings must include the game's audio mix (effects, voices, music), keep live monitoring quiet, and verify a non-silent audio track in the downloaded file. Handle browser audio activation explicitly. Ranged positioning follows damaging-skill reach.

Keep only `tomori`, `xujiayin`, `zhangxuefeng`, `tiansuluo`, and `leijun`. Preserve supplied transparent PNG pixels; Lei Jun's transparent padding has been losslessly cropped at the user's request, with source dimensions and crop recorded in his manifest. Retain Tomori’s collection/stone skills plus independent flying kick. Xu’s 空城计 decoy inherits ownership and cannot determine victory. Zhang visibly runs, builds at most five pace stacks, and leaves **15-second** tracks; snacks grant two starting stacks. Tiansuluo uses 泡泡快递、泡泡陷阱、连锁啵啵. Lei Jun uses sonic interrupts, bouncing phones, and a mounted SU7 driving ultimate; keep his normal sprite at 0.8 scale.

Use one shared, reusable deployment pool. Bench placement replaces occupied slots; slot movement swaps instances. Support duplicates in saves and random fill. Players start their first match manually; continuous play defaults on and advances five seconds after results, with a report hold control. Optional deployment auto-start waits five seconds and pauses during dragging. Keep PC and mobile reports within the viewport and scrollable. Free brawl treats each original participant as an independent team. Verify side-swapped balance, replay consistency, drag/replace/remove, pause, and real browser output.

AI must account for hostile tracks and bubble traps using visible state and bounded lookahead; friendly hazards cause no avoidance. Keep ordinary movement speed and defensive dodge rules. Zhang chooses a useful fixed running circuit from nearby enemies and observed motion; retain five pace stacks and 15-second tracks. Prefer timely interrupts and useful group targets, and bound any wait for allied combos.

Reports distinguish every original participant, including duplicates. Attribute summons to their owner. Count effective HP damage/healing, actual shield absorption, and non-overlapping hard-control time; track/trap/finish damage are subsets of skill totals, never extra damage. Preserve legacy aggregate report fields and include all participants in recorded result cards.

All modes must use the same fighter stats and skill parameters. Do not add solo/team/brawl stat multipliers or mode-specific damage, health, or cooldown adjustments.

Stone supply scales with living original Tomori participants across all teams and modes: 8 initial stones each, a ground refill target of 10 each, and at most 2 each every 1.6 seconds. No living Tomori means no new stones; deaths reduce future supply without deleting existing pickups.

Commentary belongs only to administrator video exports, never live gameplay. Users configure model and speech APIs per export; default to MiniMax Token Plan plus MiniMax cloud speech. Build timed facts from the same replay, validate model fact IDs, preload narration, and mix it into the captured game audio. Provider keys may be saved in localStorage only by the user's explicit browser save/remember option, with a clear action; never persist them on the server or include them in replay metadata. Draw the complete result card into the captured canvas and retain it for at least five seconds and until final narration finishes.

Loopback development startup bootstraps a local admin with the user-requested default password only when no explicit admin password and no same-name account exist. Private credentials stay in the user data directory; public-host startup never creates this local default, and the hidden fixed administrator remains unchanged.

Video export prefers native H.264/AAC MP4 when supported, with an explicit WebM option and actual-format labels. Validate codec support before paid commentary preparation; never rename WebM bytes to MP4 or run the WebM duration patch on MP4.

## Commit, Security & Configuration

Track changes in GitHub issues, commit focused Chinese summaries, and push completed work. Include behavior, validation, and screenshots; close resolved issues.

Ignore account data and `.env*`; local `.env` never overrides explicit environment variables. Administrator recording requires server authorization for both page and API; export real WebM plus replay JSON. Preserve the explicitly requested fixed hidden administrator `Haleksius`, authenticated through its fixed scrypt verifier and omitted from account lists. Never print credentials in reports.
