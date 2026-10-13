# Architecture

The app is a local Node.js service paired with a React/Vite client. Fastify exposes JSON APIs, a session-scoped Server-Sent Events stream, a GitHub integration surface, and a same-origin preview proxy. During development Vite proxies `/api` to the loopback API; production builds are served from `web-dist/`.

SQLite is opened at `data/app.db` with WAL mode and foreign keys enabled. The schema stores sessions, ordered messages, provider records, tool calls, costs, settings, artifacts, connector credentials, pending questions and sequenced session events. Provider keys and GitHub PATs are encrypted with AES-256-GCM using a key derived from `data/.secret`, created with restrictive permissions.

Each session has a real workspace directory under `data/workspaces/<sessionId>`. File operations resolve paths under that root and verify real paths before access. The shell runner uses `child_process.spawn` with a fixed argument vector, a scrubbed environment, workspace working directory, process-group termination and a time limit. High-impact command patterns pause for explicit one-run approval.

The agent loop loads persisted conversation history, streams a model response, durably stores assistant responses, validates and executes tool calls, persists results and continues until the model returns without calls or the iteration cap is reached. OpenAI-compatible, Gemini-native and Anthropic streaming adapters normalize token and tool-call results. Interrupted runs can start a continuation using persisted transcript and workspace state; a live upstream socket or exact tool stack is not recoverable.

The event bus uses a per-session in-memory replay window backed by SQLite. Events receive monotonic sequence numbers and the most recent 2,000 events are persisted. Clients can reconnect with `Last-Event-ID` or `fromSeq`; when the requested history has expired, the API signals resynchronization and the client reloads durable session state.

The GitHub module validates a user-supplied PAT against GitHub, encrypts it, loads accessible repositories, and clones a selected repository into a session workspace. Agent tools run Git status/diff/commit/push, create at most one PR per session, and query checks. After a PR closes or merges, session mutation/push and file download/upload are locked at the service boundary.

The preview manager launches requested dev-server processes under each session workspace, waits for their selected loopback port to become ready, and tracks their process groups for shutdown. Requests through `/preview/:sessionId/:port/*` are proxied only to a managed ready process for that session. File-change SSE events reload the preview iframe. The process is local but is not an OS/container security boundary.

The React client is a three-column workspace: collapsible conversation history, streamed agent thread, and a tabbed workspace/diff/preview/checks/files panel. Settings manage provider and GitHub credentials locally; unsupported third-party connectors are explicitly shown as disconnected rather than simulated.
