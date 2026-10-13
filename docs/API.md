# HTTP API

All routes are served by the local Fastify server. JSON requests use `Content-Type: application/json` unless noted.

## Health and diagnostics

- `GET /api/health` — service and database health (public even when auth is on)
- `GET /api/ready` — readiness probe (200/503) for load balancers
- `GET /api/metrics` — process/system resource metrics and effective security config
- `GET /api/diagnostics` — runtime, data path, SQLite integrity, provider catalog counts

When `APP_AUTH_TOKEN` is set on the server, every `/api` and `/preview` route
except health/ready requires `Authorization: Bearer <token>` (or
`?access_token=` for SSE/downloads). Requests are rate limited per IP
(`RATE_LIMIT_MAX` reads, `RATE_LIMIT_WRITE_MAX` writes per
`RATE_LIMIT_WINDOW_MS`); excess returns `429` with `Retry-After`.

## Connectors

- `GET /api/connectors` — Notion/Drive/Docs/Gmail/Linear/Cal status (account + masked credential only)
- `POST /api/connectors/:id/connect` — validate a user token against the live upstream API and store it encrypted (`{ token }`)
- `POST /api/connectors/:id/test` — re-validate the stored credential
- `DELETE /api/connectors/:id` — remove the stored credential

## Sessions

- `GET /api/sessions` — active session list
- `POST /api/sessions` — create a session (`{ title? }`)
- `GET /api/sessions/:id` — session, messages, run status, pending question
- `PATCH /api/sessions/:id` — update title, archive/pin, provider/model
- `DELETE /api/sessions/:id` — delete a session
- `GET /api/history/search?q=...` — FTS5 message search
- `POST /api/sessions/:id/messages` — start a streamed agent turn (`{ content, providerId?, modelId?, reasoning?, mode? }`; `mode: "direct"` runs with no tools offered, `"agent"` is the default)
- `POST /api/sessions/:id/compare` — Side-by-Side/Battle comparison (`{ content, a: { providerId, modelId }, b: { providerId, modelId } }`); both models answer without tools, per-side errors settle independently, and the exchange is persisted to the transcript
- `POST /api/sessions/:id/stop` — abort the active run
- `POST /api/sessions/:id/resume` — resume an interrupted, errored, or persisted paused run from transcript/workspace state
- `POST /api/sessions/:id/answer` — resume an active pending `ask_user` (`{ callId, answer }`)
- `DELETE /api/sessions/:id/messages` — clear transcript, tool/cost/artifact history while preserving workspace files
- `GET /api/sessions/:id/costs` — session totals and per-provider-call ledger
- `GET /api/sessions/:id/stream?fromSeq=n` — session SSE events; supports `Last-Event-ID`
- `GET /api/sessions/:id/export?format=json` — JSON export; default is Markdown

## GitHub

- `GET /api/github/status` — connection state, selected repositories, and last stored quota metadata
- `POST /api/github/connect` — validate and encrypt a PAT (`{ token }`); returns live repository listing
- `DELETE /api/github/connect` — clear encrypted PAT but preserve selected repositories
- `GET /api/github/repos` — list accessible repositories from GitHub
- `PUT /api/github/repos` — save checked repository names (`{ selectedRepos }`)
- `POST /api/sessions/:id/github/clone` — shallow clone selected repo and create a session branch (`{ repo, baseBranch }`)
- `GET /api/sessions/:id/github/status` — repository, branch, PR and lock state
- `GET /api/sessions/:id/diff?full=1` — full branch diff; default is working-tree diff
- `GET /api/sessions/:id/checks` — current commit check-runs and commit status

## Preview

- `GET /api/sessions/:id/previews` — session's ready or failed preview processes
- `POST /api/sessions/:id/previews/start` — start a local command and wait for HTTP readiness (`{ command, port, timeoutMs? }`)
- `POST /api/sessions/:id/previews/stop` — stop all session previews or one port (`{ port? }`)
- `GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /preview/:sessionId/:port/:path*` — same-origin proxy to a managed loopback preview process
- Workspace file, upload, and ZIP download routes return a locked-workspace error after the session PR is merged/closed.

## Providers

- `GET /api/providers` — provider details with masked credential, no plaintext secrets
- `POST /api/providers` — add a provider
- `PATCH /api/providers/:id` — update provider details
- `DELETE /api/providers/:id` — delete a non-default provider
- `POST /api/providers/:id/default` — set the default provider
- `POST /api/providers/:id/refresh-models` — fetch the live provider catalog
- `POST /api/providers/:id/test` — fetch models and perform a real short streamed completion

## Workspace

- `GET /api/sessions/:id/workspace` — list workspace files
- `GET /api/sessions/:id/file?path=...` — return a confined file
- `POST /api/sessions/:id/upload` — multipart file upload (25 MB per file, magic-byte validated)
- `POST /api/sessions/:id/upload/chunk` — chunked upload (fields `uploadId`, `fileName`, `chunkIndex`, `totalChunks` + one file part per chunk; assembled, magic-byte validated, then moved into the workspace)
- `GET /api/sessions/:id/download-workspace` — stream a workspace ZIP
- `GET /api/sessions/:id/artifacts` — presented artifacts

## Settings and approvals

- `GET /api/settings`, `PUT /api/settings/:key` — local JSON settings
- `POST /api/approvals/:id` — respond to a shell approval (`{ approved: boolean }`)
