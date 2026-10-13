# Changelog

## 1.6.0 — Electron desktop app (single portable EXE)

- The full app (React UI + Fastify backend + SQLite) now ships as a Windows desktop app: Electron's main process (`electron/main.ts`) boots the same backend on 127.0.0.1 as a utility process, waits for `/api/health`, and opens the UI in a native window. User data (sessions, workspaces, encrypted keys) lives in the OS app-data folder (`%APPDATA%/Galaxy Agent/data`), so the exe itself is stateless and movable.
- `npm run app:build` produces **one portable file** — `dist-electron/Galaxy-Agent-<version>-portable.exe` — no installer, no separate server to start (electron-builder `portable` target, `asarUnpack` for the native `better-sqlite3` module, native deps rebuilt for Electron automatically). `npm run app:dev` runs the desktop shell from the repo; the plain web flow (`npm start`, port 4310) is unchanged.
- The backend now resolves `web-dist` relative to its own file (or `WEB_DIST_DIR`) instead of the process cwd, which packaged apps cannot rely on.
- Note: the sandbox used to develop this cannot download the Electron binary (GitHub release-asset CDN is egress-blocked), so the final `.exe` packaging step runs on a Windows machine with `npm run app:build` (cross-compiling the native `better-sqlite3` module from Linux is not supported by node-gyp); everything else (main-process compile, backend resolution, test suite) is covered here.

## 1.5.0 — Offline demo provider

- New built-in **Offline demo** provider kind (Settings → Providers → Provider type): needs no API key and no internet. "Connect provider and fetch models" returns two built-in models (Concise / Detailed), and chat, Agent/Direct modes, and Battle/Side-by-Side all stream clearly-labelled sample replies. This makes the whole app testable in network-restricted previews where real LLM endpoints (Kilo, OpenRouter, OpenAI…) cannot be reached; it never calls tools and never pretends to be a real model.

## 1.4.4 — Fetch-models error visibility

- Provider catalog failures now return **424 (Failed Dependency)** instead of 502, because some reverse proxies replace upstream-502 bodies with their own error page — which reduced the detailed "Could not reach …" message to a bare "Request failed (502)" in the UI.
- The API client now falls back to the raw response text when an error body is not JSON, so an actionable reason is shown whenever one exists.
- "Connect provider and fetch models" no longer looks like a total failure when only the catalog fetch fails: the provider stays saved/default and the message says exactly that (this was causing duplicate provider entries).

## 1.4.3 — Stale-bundle guard

- Fetch-models failures no longer collapse into the generic "The local server could not complete the request": unreachable providers, HTTP 401/403 (bad key) and non-JSON catalog responses now return 502 with the real reason and a base-URL hint, shown directly in the UI.

- `index.html` is now served with `Cache-Control: no-store` so browsers can never pin an old JS bundle after a rebuild (hashed assets remain cacheable). This prevents "fixed on the server, still broken in my tab" situations like the empty-body error persisting in a cached client.

## 1.4.2 — "Body cannot be empty" fix

- Fixed the error shown when pressing Fetch models (and other action buttons): the UI sent `Content-Type: application/json` even for POSTs without a payload (stop, resume, refresh-models, set-default, provider test…), which Fastify rejected with "Body cannot be empty when content-type is set to 'application/json'". The server now parses an empty JSON body as `{}`, the client only declares a JSON content type when it actually sends a body, and an e2e regression test covers no-body JSON POSTs (malformed JSON still returns 400).

## 1.4.1 — Sidebar close fix

- The chat sidebar now actually closes: on desktop the toggle fully hides it (a floating reopen button appears at the top-left, including on the home screen where there is no topbar); on mobile the drawer gets a visible close (×) button, a tap-outside backdrop, and it auto-closes after picking a chat, New chat, Leaderboard or Settings. Also fixed the brand pill still showing "A" after the Galaxy rename (now "G").

## 1.4.0 — Original-parity cross-check pass

Re-audited the clone against the live original Agent page (`arena.ai/agent`, fetched 2026-10-13) and closed the remaining gaps:

- **Leaderboard** (present in the original nav, missing here): sidebar entry with a "New" badge opening local standings — Battle Mode win/loss/win-rate per model (from your picks, stored on-device) plus per-model usage (chats, tokens, cost) aggregated from your sessions.
- **Message actions**: Copy, Regenerate (re-sends the last prompt), thumbs up/down feedback (persisted locally) on assistant replies; Edit (loads back into the composer) and Copy on your messages.
- **Reasoning effort control** (Low/Medium/High) in the model menu, wired into agent/direct runs instead of the previously hard-coded medium.
- Empty-state composer now matches the original exactly ("Ask anything…", grid-plus + Agent on the left, voice + send on the right; the extra sliders button was removed) — the in-chat composer keeps "What would you like to do?" as in the original's chat screen.
- Upload per-file limit aligned with the original: 25 MB (multipart and chunked assembly, docs updated). Workspace file tree now indents nested paths.

## 1.3.1 — Nothing opens by itself

- Fixed panels/popups opening on their own: the right Workspace panel no longer starts open, the agent's `present_file` event no longer force-opens the Files tab mid-run (or when replaying an old chat), and the Shift+Tab shortcut no longer cycles/opens panels while typing.
- The tune/sliders button next to the Agent pill now opens the Chat/Agent mode menu (Direct · Agent · Side by Side · Battle) instead of jumping into Settings; Settings opens only from its explicit buttons/commands.
- Sending a message now closes any open composer menus. Every remaining panel, sheet and dialog opens only from an explicit click or command.

## 1.3.0 — Renamed to Galaxy

- The product is renamed from **Arena Agent** to **Galaxy Agent**: UI wordmark and hero logotype ("galaxy" / "Galaxy"), page title, npm packages (`galaxy-agent-local`, `@galaxy-agent/web`), health/metrics service name, Docker service/image/volume, Git author identity, agent branch prefix (`galaxy/…`), HTTP user-agents, and browser storage keys (`galaxy-theme`, `galaxy-app-token`).
- Upload staging moved from `.arena-uploads` to `.galaxy-uploads` (the old name stays in the workspace ignore list). Existing sessions, workspaces and encrypted provider keys are unaffected; a previously saved browser theme/app-token resets once because the storage keys changed.
- Also fixed: sending a message before configuring any provider now returns HTTP 400 with the actionable message instead of a generic 500.
- Historical documents (decision/comparison/run reports) still cite "Arena" where they factually describe the external reference product the original design was compared against.

## 1.2.0 — Original thread UX: grouped activities, modes, connectors sheet

- Replaced individual tool cards with the original Arena-style grouped, collapsible activity feed ("Ran commands N", "Edited files N", "Explored N read(s)") whose rows read `used Bash ✓ 147ms`, plus inline file cards with extension chips (MD/JS/…) that open in the file viewer.
- Added the composer Connections popover (connected GitHub toggle, Connect actions, "View all connectors", "Add files") and a bottom Connectors sheet matching the original cards/descriptions; connector 7 is now correctly **Google Calendar** (`google_calendar_events`) instead of Cal.com.
- Added the session-title context menu (Rename with inline editing, red Archive via the existing session PATCH, Delete) and a functional mode menu — Agent Mode, Direct (backend run with no tools offered), Side by Side (two chosen models, `POST /api/sessions/:id/compare`) and Battle Mode (two anonymous random models; names reveal after you pick a winner).
- Workspace panel is now sheet-styled with real usage counters (MB/128MB, files/10K), folder tree rows and a bottom Connectors bar; on mobile it behaves as a bottom sheet. Composer placeholder is "What would you like to do?" with the grid-plus connections button.
- Validation errors now return HTTP 400 (previously 500). Tests: 35 unit + 5 integration + 9 e2e, all green via `npm run check`.

## 1.1.0 — Original-style UI + enterprise production pass

- Rebuilt the default theme to match the public Arena Agent reference (light warm background, narrow home rail, serif "Experience the frontier" hero with yellow highlight, original composer and connector row); dark theme kept as an Appearance option. Side-by-side proof: `reference/comparison-original-vs-clone.png` (see `docs/UI_COMPARISON.md`).
- Added real token-based connectors (Notion, Google Drive, Google Docs, Gmail, Linear, Google Calendar — listed as Cal.com in 1.1.0, corrected in 1.2.0): live upstream validation, encrypted storage, Settings UI, connector pills with live status, and agent tools (`notion_search`, `linear_issues`, `google_drive_search`, `google_docs_search`, `gmail_list`, `google_calendar_events`).
- Added provider failover (pre-stream, across enabled providers), deterministic context compaction (`context_compacted` event), PDF text extraction + image metadata in `read_file`, and audio waveform rendering in the file viewer.
- Enterprise hardening: optional bearer-token auth (`APP_AUTH_TOKEN`), per-IP read/write rate limits with `Retry-After`, strict CSP/security headers (preview proxy excluded), `/api/ready`, `/api/metrics` + live Settings → Advanced metrics, chunked uploads with progress, preview port selector fix, voice input where supported.
- Operations: multi-stage Dockerfile, hardened docker-compose, GitHub Actions CI, `npm run backup`, expanded `.env.example`, production runbook (`docs/PRODUCTION.md`).

## 1.0.0 — Local agent core

- Added local SQLite session persistence and encrypted provider keys.
- Added live provider model discovery and streaming adapters for OpenAI-compatible APIs, Gemini native, and Anthropic.
- Added SSE-backed agent loops and workspace shell/file/web tools.
- Added a responsive chat UI with local session history, tool cards, provider settings, workspace tree, artifact viewer, and exports.

## Local workflow completion pass

- Added encrypted GitHub PAT connection, repository selection, session clone/branch workflow, Git lifecycle/PR/check tools, live diff panel, and post-PR workspace lock enforcement.
- Added a real loopback preview process manager and same-origin iframe proxy with file-change reload and multiple preview selection.
- Persisted sequenced SSE replay in SQLite and added interrupted-session continuation from transcript/workspace state.
- Added command palette/shortcut/slash actions, clipboard file staging, safe-format upload validation, clear-session/cost APIs, and expanded upload/preview end-to-end tests.
- Restored the full dark-theme stylesheet and captured an updated local preview screenshot.
