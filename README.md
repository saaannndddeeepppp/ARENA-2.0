# Galaxy Agent — Local Workspace

A local-first agent workspace inspired by the public Arena Agent Mode layout. It provides persistent local sessions, a real workspace directory, dynamic provider model discovery, streamed agent text and tool events, and a compact dark chat/workspace interface. There is no login or account gate.

## Requirements

- Node.js 20 or newer
- npm
- A model-provider API key (optional for browsing the UI; required to run an agent turn)

## Run from a clean checkout

```bash
npm run setup
npm run dev
```

Open <http://localhost:5173>. The local API is at <http://localhost:4310/api/health>. To use the production build:

```bash
npm run build
npm start
```

`npm run setup` installs packages, creates `data/app.db`, initializes the SQLite schema, and writes a random `data/.secret` file with mode `0600`. Local app data and workspaces are kept in `./data/`; deleting that directory removes local app state. No container runtime is used.

## First run

The UI defaults to the light Galaxy theme (Settings → Appearance can switch to dark). Open **Settings → Providers**, add a provider, and fetch its live model catalog. The provider key is encrypted locally using AES-256-GCM. Provider requests originate from the server. Keys are masked in the UI and never included in API responses.

Create a chat and ask the agent to work in its session workspace. The shell tool runs in that workspace with a scrubbed environment. Commands matching high-impact patterns pause for explicit approval. Web search uses DuckDuckGo's public HTML interface; fetching public pages is supported with local/private IP restrictions.

## Included capabilities

- SQLite-backed sessions, messages, provider settings, tool-call records, artifacts, and token counts
- Live `/models` discovery for OpenAI-compatible services, Kilo, OpenRouter, Gemini, and Anthropic
- Streaming chat/tool loop for OpenAI-compatible, native Gemini, and Anthropic APIs
- Workspace-confined shell, file read/write/edit, file presentation, web search, public page fetch, plan checklist, user-question pause, and shell approval tools
- Wikimedia Commons image search/download with attribution metadata, provider-backed OpenAI-compatible image generation/edit, provider-backed text-to-speech, and an inline audio player
- Encrypted GitHub PAT connection, searchable repo selection, shallow session clone, branch creation, commit/push/PR/check tools, Git diff panel, and post-PR lock rules
- Real loopback development-server process manager and same-origin preview proxy with device-width presets, refresh, file-change reload, and multi-port selection
- Per-session SSE event stream with a durable SQLite-backed sequence ring (last 2,000 events) and replay after reconnect/restart
- Workspace file tree, file viewer, downloads, zip, Markdown/JSON exports, upload, and session search
- Interrupted and paused sessions restore transcript/workspace state, expose Resume, and can continue after process restart
- Responsive dark UI with live tool cards and model selection

## Honest scope notes

Implemented in 1.1.0: real token-based Notion, Google Drive/Docs/Gmail, Linear and Google Calendar connectors (validated against the live APIs, stored encrypted, exposed as agent tools); provider failover before streaming starts; deterministic model-context compaction with a `context_compacted` event; PDF text extraction and image metadata in `read_file`; audio waveform rendering in the file viewer; magic-byte validation for every allowed upload type plus chunked uploads (4 MB chunks) for large files; and process/resource monitoring via `/api/metrics`. Enterprise hardening: optional `APP_AUTH_TOKEN` bearer auth, per-IP rate limiting, strict security headers/CSP, `/api/ready`, Docker + compose, CI, and `npm run backup` (see `docs/PRODUCTION.md`). Still not implemented: a Google OAuth refresh-token flow (access tokens expire ~1h), pixel-level image understanding beyond metadata (requires a vision model call), and multi-replica/multi-tenant operation. Restart recovery replays persisted events and resumes from the transcript/workspace rather than restoring an in-flight provider socket or exact tool-call stack. Image and speech generation require a compatible configured provider endpoint and may incur provider charges. See `docs/DECISIONS.md`, `docs/PRODUCTION.md` and `docs/UI_COMPARISON.md`.

## Scripts

- `npm run setup` — install and initialize local state
- `npm run dev` — local API and Vite development client
- `npm run build` — compile server and build browser client
- `npm start` — run the production server and serve the built client
- `npm run typecheck` — strict TypeScript checks
- `npm test` — unit and integration tests
- `npm run doctor` — database and shell diagnostics
- `npm run backup` — consistent SQLite backup into `data/backups/`
- `npm run check` — lint + all tests + production e2e
- `npm run seed:demo` — add an illustrative local session

## Safety

The app intentionally has no authentication and is designed for a single trusted machine. The API and development frontend bind to loopback by default; do not change `HOST` or `VITE_HOST` to a network interface on an untrusted network. The shell tool executes commands as the OS user; workspace confinement for file operations does not sandbox arbitrary shell behavior. Review `docs/SECURITY.md` before using it with sensitive data.
