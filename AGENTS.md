# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free, vanilla JavaScript/Canvas auto-battler with an optional Node.js account server.

- `index.html`, `account.html`, and `sim-watch.html` provide gameplay, accounts, and the simulation workbench.
- `js/` contains browser modules sharing `globalThis.CC`: combat (`engine.js`, `ai.js`, `battle.js`), rendering, input, UI, and mobile support.
- `server.js` serves allowlisted files and account APIs; `lib/users.js` stores accounts, and `lib/simhost.js` runs deterministic headless battles.
- `assets/` holds committed sprites, backgrounds, effects, and audio. `styles.css` and `mobile.css` define desktop and responsive layouts.
- `deploy/` contains container, nginx, systemd, and deployment instructions; `docs/img/` contains documentation screenshots.

## Build, Test, and Development Commands

Use Node.js 18+ (22 recommended). No package installation or build step is required.

- `node server.js`: serve locally at `http://127.0.0.1:8130`; occupied ports advance automatically, so check startup output.
- `node server.js --port 8131 --mode view`: exercise guest permissions locally.
- `node --check server.js`: check server syntax; repeat for changed JavaScript files.

See `deploy/DEPLOY.md` for production setup.

## Coding Style & Naming Conventions

Follow surrounding code: two-space JavaScript indentation, semicolons, single-quoted strings, `camelCase` functions/variables, and uppercase constants. Browser modules use strict-mode IIFEs and export through `CC`; server modules use CommonJS. Preserve HTML script dependency order. No formatter or linter is configured.

Keep simulation logic independent of DOM/rendering, advance at fixed 1/60-second ticks, and use the seeded battle RNG. Name unit sprites `assets/units/meme/<id>.png`, matching IDs in `js/fighters.js`.

## Testing Guidelines

No automated test framework or coverage threshold is committed. `tests/`, `tools/`, and `run-tests.js` are intentionally ignored; README verification commands require those separate local tools.

Use `/sim-watch.html` for seeded replay, stepping, and batch 1v1/6v6 checks; `/sim-watch.html?shot=1&t=9&seed=123` freezes a reproducible frame. Verify pause/resume, placement, account permissions, missing-asset fallback, and mobile layouts when affected. Record seeds and observed results.

## Commit & Pull Request Guidelines

Existing commits use short Chinese change summaries. Write focused Chinese messages, optionally prefixed with `docs:`, `fix:`, or `feat:`. Track requested changes in GitHub issues; link the issue in the PR, describe behavior changes and validation, and include screenshots for visual changes. Close the issue after completion.

## Security & Configuration

Never commit `data/`, `.env` files, or tokens. Configure `CC_ADMIN_PASS`, `CC_SECRET`, and optionally `CC_DATA_DIR` externally. Preserve account data and the server's static-file allowlist.

## Agent Notes

Reply to the user in Chinese. AI changes must preserve seeded replay and resource-collecting character behavior; validate skill conditions, targeting, movement, and battle convergence with fixed seeds. Keep development test scripts in ignored `tools/` or `tests/`.
