# Sandbox run report — 2026-10-13

This file records what was actually executed in the Arena sandbox after
unzipping `arena-agent-clone-source.zip` into the repository root. It does not
replace `docs/TEST_REPORT.md` (the original author's report); it verifies that
report independently.

## What was done

1. Unzipped `arena-agent-clone-source.zip` into the repository root (the zip
   itself is kept, tracked, as the original upload).
2. Installed dependencies, initialized local state, and ran lint, unit,
   integration and e2e tests, a production build, diagnostics, and an npm
   audit.
3. Seeded the demo session and started the production server
   (`HOST=0.0.0.0 PORT=4310 npm start`, serving `web-dist/` + `/api` on one
   origin) for the live preview.

## Sandbox-specific install note

Plain `npm run setup` fails **in this sandbox only**: `better-sqlite3`'s
`prebuild-install` fails certificate verification and the `node-gyp` fallback
tries to download Node headers from `nodejs.org`, which is not in the
sandbox's outbound allowlist. The workaround is to use the locally installed
headers:

```bash
export npm_config_nodedir=/usr/local
npm install
npm run setup:local
```

On a normal machine with unrestricted network access, `npm run setup` works
as documented in `README.md` and this workaround is unnecessary.

## Verified results (2026-10-13, Node v22.22.3)

| Check                           | Result                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `npm run setup:local`           | Passed — `data/app.db` created, `data/.secret` mode `0600`         |
| `npm run doctor`                | Passed — SQLite `ok`, shell `arena-agent-ok`, 0 providers          |
| `npm run lint`                  | Passed — strict TS (server + web) and Prettier clean               |
| `npm test` (unit + integration) | Passed — 20 unit + 5 integration tests                             |
| `npm run test:e2e`              | Passed — production build + 4 HTTP e2e tests                       |
| `npm run build`                 | Passed — `server/dist/` + `web-dist/` (JS 364 kB / 111 kB gz)      |
| `npm audit --audit-level=low`   | Passed — 0 vulnerabilities                                         |
| Source hygiene scan             | Passed — no `TODO`/`FIXME`/`XXX`/`HACK` in `server/src`, `web/src` |
| Excluded-feature scan           | Passed — no leaderboard/battle/Elo/voting code                     |
| `GET /api/health` (live)        | `{"ok":true,...,"database":"ok"}`                                  |
| `GET /` (live)                  | HTTP 200, serves the built React app                               |
| `GET /api/sessions` (live)      | Returns the seeded demo session                                    |

## Code review summary

Strengths:

- File tools confine paths to the per-session workspace (`safePath` +
  `assertConfined` realpath checks in `server/src/workspace.ts`), symlinks
  are skipped in tree listing, and uploads are extension-allowlisted,
  size-capped (50 MB/file) and signature-checked (see `docs/SECURITY.md`).
- Secrets are encrypted at rest with AES-256-GCM (`server/src/crypto.ts`),
  masked in API responses, and `data/.secret` is created `0600`.
- Shell tool uses a scrubbed environment, a fixed `bash` invocation,
  process-group termination, timeouts and one-run approval for high-impact
  patterns (`dangerPatterns` in `server/src/tools.ts`).
- Preview proxy only routes to ports managed for that session and connects
  to `127.0.0.1` with manual redirect handling (`server/src/preview.ts`).
- Tests are real, not mocked theatre: preview tests launch real loopback
  servers, integration tests execute real file/shell operations and verify
  path-escape denial, e2e tests exercise the production build over HTTP.

Risks / honest limits (also documented by the author in
`docs/SECURITY.md` and `docs/DECISIONS.md`):

- **No authentication at all.** The app is single-user/local-only by design.
  In this sandbox the server is bound to `0.0.0.0:4310` solely so the Arena
  live preview can reach it; do not expose it on an untrusted network.
- The shell tool is **not** an OS sandbox: commands run as the OS user and
  can leave the workspace. Workspace confinement applies to file tools, not
  arbitrary shell commands.
- `fetch_page` blocks known private/local targets but does no DNS pinning —
  it is a light SSRF guard, not a hardened gateway.
- Not implemented: Google/Notion/Linear/Cal connectors, provider failover,
  context compaction, full PDF/image understanding, audio waveform,
  exhaustive upload magic-byte checks, OS-level quotas (see `README.md`).
- Restart resume rebuilds a continuation from the persisted transcript and
  workspace; an in-flight provider socket or exact tool-call stack is not
  restored.
- Real model/GitHub/media flows were **not** exercised here: no provider API
  key or GitHub PAT was supplied in the sandbox.

## How to run locally

```bash
npm run setup     # install + initialize data/
npm run dev       # API :4310 + Vite :5173
# or production:
npm run build
npm start         # serves API + built web UI on :4310
```

Then open **Settings → Providers**, add a provider, and fetch its live model
catalog before starting an agent turn.

## Addendum — 1.1.0 completion pass (2026-10-13)

A second pass implemented the previously-listed gaps and re-verified
everything in the same sandbox: 31 unit + 5 integration + 6 e2e tests pass,
lint/build/audit clean, `/api/ready`, `/api/metrics` and `/api/connectors`
verified live, and the original-vs-clone comparison screenshot is kept at
`reference/comparison-original-vs-clone.png`. External connector calls are
validated by mocked-upstream unit tests; no real third-party credentials
were available in the sandbox. See `docs/UI_COMPARISON.md` and
`docs/PRODUCTION.md`.
