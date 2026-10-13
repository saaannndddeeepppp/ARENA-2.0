# Security

## Data and credentials

All app data is stored below `./data/`. The SQLite database uses WAL mode. Provider secrets and GitHub PATs are encrypted at rest with AES-256-GCM and a key derived from `data/.secret`, created with restrictive permissions. The UI/API never return token plaintext. Structured logging redacts common key fields; GitHub request payloads are not logged.

## Workspace access

File tools constrain resolved paths to the session workspace and reject symlinks in tree enumeration. Upload names are stripped of path separators and control bytes, executable extensions are denied, supported extensions are allowlisted, common binary file signatures are checked, text files must decode as UTF-8, and uploads are capped at 25 MB each/200 MB per request. HTML artifact files are shown in a sandboxed iframe. The Markdown renderer does not enable raw HTML.

## Shell risk

The shell tool executes arbitrary commands as the current operating-system user. A workspace working directory and scrubbed environment reduce accidental exposure but do **not** confine shell commands to that directory or prevent network access. High-impact command patterns prompt for explicit approval, and the user can stop an active process. The app is single-user and must not be exposed to untrusted networks. Do not run untrusted prompts with access to sensitive home-directory files or credentials.

## Network risk

Provider API calls are sent only after the user configures a provider. GitHub API calls and authenticated `git` operations happen only after a PAT is configured and a repo is selected. Web search, public-page fetching, and Wikimedia Commons image search/download make outbound requests when called. Image search returns attribution and license fields from Wikimedia metadata. The page fetcher rejects common private IPv4 and local host targets and checks redirects, but this lightweight local implementation is not a hardened SSRF gateway and does not perform DNS pinning. Use it only in a trusted environment.

The preview proxy accepts only a port with a live preview process managed for that session and connects to `127.0.0.1`. It does not follow upstream redirects. The preview command still runs as the OS user and may bind other addresses or access the network; this is a convenience proxy, not an isolation boundary. HTML/CSP frame headers are adjusted for the iframe, and uploaded HTML remains sandboxed.

## Production mode (1.1.0)

Setting `APP_AUTH_TOKEN` (≥16 chars) requires `Authorization: Bearer …` on
all `/api` and `/preview` routes (health/ready remain public for probes;
SSE and downloads may use `?access_token=`). Tokens are compared in constant
time. Requests are rate limited per IP with separate read/write budgets.
Non-preview responses carry a strict CSP and standard hardening headers.
Connector credentials (Notion/Linear/Cal keys, Google OAuth access tokens)
are validated against the live upstream API before storage and encrypted the
same way as provider keys; Google access tokens expire (~1h) and must be
re-pasted — treat them like passwords while valid. See `docs/PRODUCTION.md`
for container hardening (non-root, read-only FS, dropped capabilities).

## Limitations

The app has no authentication, access control, rate limiting, safe mode, process quota, disk quota, exhaustive MIME sniffing for every format, or operating-system sandbox. Event history is durable and sequenced, and pending question answers can restart a continuation from saved transcript/workspace, but a live provider connection or exact tool-call stack is not restored. These limitations are material; the app is intended for local development, not a multi-user or internet-facing deployment.
