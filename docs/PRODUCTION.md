# Production runbook

This app began as a local-first, single-user workspace. Version 1.1.0 adds the
operational layer needed to run it as a small enterprise/internal service.
Read this together with `docs/SECURITY.md` — the shell tool still executes as
the OS user and is **not** an OS sandbox.

## Run modes

### Local (default, unchanged)

```bash
npm run setup
npm run dev        # or: npm run build && npm start
```

No authentication; binds to loopback by default. This is the correct mode for
a single trusted machine.

### Container (recommended for shared/internal hosting)

```bash
APP_AUTH_TOKEN="$(openssl rand -hex 32)" docker compose up --build
```

The compose file publishes only `127.0.0.1:4310`, runs as the `node` user,
drops all capabilities, uses a read-only filesystem (`/app/data` is the named
volume, `/tmp` is tmpfs) and defines a healthcheck against `/api/ready`. Put
a TLS-terminating reverse proxy in front for any network exposure, paste the
same token into Settings → Advanced in each browser, and keep shell access in
mind: anyone who can use the agent can run shell commands as the container
user.

Build without compose:

```bash
docker build -t galaxy-agent-local:1.6.0 .
docker run --rm -p 127.0.0.1:4310:4310 -v galaxy-data:/app/data \
  -e APP_AUTH_TOKEN="$APP_AUTH_TOKEN" galaxy-agent-local:1.6.0
```

## Configuration (environment)

| Variable               | Default              | Purpose                                                                                                                                                                              |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST` / `PORT`        | `127.0.0.1` / `4310` | Bind address/port. Container sets `0.0.0.0`.                                                                                                                                         |
| `DATA_DIR`             | `./data`             | SQLite DB, `.secret`, workspaces. Back this directory up.                                                                                                                            |
| `APP_AUTH_TOKEN`       | _(unset)_            | If set (≥16 chars), all `/api` + `/preview` routes require `Authorization: Bearer …` (or `?access_token=` for SSE/downloads). `/api/health` and `/api/ready` stay public for probes. |
| `RATE_LIMIT_MAX`       | `1200`               | Read requests per window per IP.                                                                                                                                                     |
| `RATE_LIMIT_WRITE_MAX` | `300`                | Write requests per window per IP. `429` + `Retry-After` on excess.                                                                                                                   |
| `RATE_LIMIT_WINDOW_MS` | `60000`              | Rate-limit window.                                                                                                                                                                   |
| `CONTEXT_MAX_CHARS`    | `160000`             | Transcript budget before deterministic context compaction runs.                                                                                                                      |
| `FAILOVER_ENABLED`     | `true`               | Try the next enabled provider when one fails before streaming starts.                                                                                                                |
| `LOG_LEVEL`            | `info`               | Pino log level. Secrets are redacted from structured logs.                                                                                                                           |

## Health, readiness, metrics

- `GET /api/health` — liveness (service + SQLite integrity + `authRequired`).
- `GET /api/ready` — readiness for load balancers (200/503).
- `GET /api/metrics` — JSON process/system metrics: RSS/heap/CPU, load
  average, memory, DB size, session/message/provider/tool/artifact counts,
  running sessions, and the effective security configuration. The Settings →
  Advanced tab renders the same data live.

Every response carries `X-Request-Id`; API responses also carry rate-limit
headers. Responses include a strict CSP (except the preview proxy, which must
serve arbitrary dev apps), `nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` and COOP.

## Backup & restore

```bash
npm run backup     # consistent SQLite backup into data/backups/
```

For a full restore point, stop the app and archive the entire `data/`
directory (database, `.secret`, workspaces). Restore by putting `data/` back
and starting the app. Losing `data/.secret` makes stored provider/GitHub/
connector credentials unrecoverable — back it up with the database.

## CI

`.github/workflows/ci.yml` runs install, lint (strict TS + Prettier), unit +
integration tests, production build + HTTP e2e tests, and `npm audit`.

## Remaining enterprise limits (honest)

- Single-process, in-memory rate limiter and preview registry: run one
  replica per data directory. There is no multi-tenant isolation; one app
  token is shared by trusted users.
- Provider failover works between providers with cached catalogs and only
  before any text has streamed; mid-stream failures are surfaced, not masked.
- Connectors use user-supplied tokens (Notion/Linear/Cal API keys, Google
  OAuth access tokens). Google access tokens expire (~1h); a full OAuth
  refresh-token flow is not bundled.
- Shell commands and preview processes run as the app user/container user.
  For untrusted prompts, run the container with a dedicated volume and no
  network egress beyond provider APIs.
