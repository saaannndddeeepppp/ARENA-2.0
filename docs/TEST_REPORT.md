# Test report

Validation completed in the local Sandbox on 2026-10-13. This report records executed checks only; external credentials were not supplied.

## Automated checks

- `npm run lint` — **passed**: strict server/client TypeScript checks and Prettier validation.
- `npm test` — **passed**: 20 unit tests and 5 real workspace/media-prerequisite integration tests.
  - Provider protocol tests cover OpenAI-compatible, Anthropic, and Gemini streaming/tool-call parsing.
  - Security/event tests cover encrypted secrets, masked-key presentation, durable event replay, and bounded history.
  - GitHub tests exercise token validation/error handling, repository selection persistence, and disconnect behavior with mocked HTTP responses.
  - Preview unit tests launch/stop real localhost processes and cover invalid ports/readiness failures.
  - Workspace/tool integration tests execute real file writes/reads/edits, shell commands, path-escape denial, and media prerequisite errors.
- `npm run test:e2e` — **passed**: production build plus 4 HTTP end-to-end tests against an isolated temporary data directory. Tests cover no-auth health/session creation, allowed Markdown upload and executable-extension rejection, a real child-process preview with HTML asset-path rewriting and shutdown, and clearing conversation data while keeping the workspace.
- `npm run doctor` — **passed**: Node v22.13.0, SQLite integrity `ok`, shell launch `arena-agent-ok`.
- `npm audit --audit-level=low` — **passed**: 0 known vulnerabilities.
- Source hygiene scan — **passed**: no `TODO`, `FIXME`, `XXX`, `HACK`, or `not implemented` markers in `server/src` or `web/src`.
- Excluded-feature scan — **passed**: no leaderboard, battle-mode, Elo, or voting functionality in source.

## Runtime/manual checks

- Live unauthenticated model catalog smoke test — **passed** earlier in the session: OpenRouter and Kilo catalogs returned 660 and 390 models, respectively; temporary database rows were removed.
- Wikimedia Commons image-search/download smoke test — **passed** earlier in the session: a real image was downloaded with attribution/license metadata; temporary workspace state was removed.
- Preview public app — **visually checked** after correcting a stylesheet regression. Browser computed styles confirmed the near-black background and 256 px sidebar. The `Ctrl/Cmd+K` command palette opened and displayed 10 actions.
- Preview process — **verified by tests** with an actual local child server and same-origin proxy; no GitHub or media-generation credentials were present.

## Not verified / remaining scope

No user provider key, GitHub PAT, Google OAuth credentials, Notion/Linear/Cal keys, or speech/image generation key was supplied. Therefore a real paid model completion, authenticated GitHub clone/PR/CI against the user's account, and the third-party productivity connector workflows were not exercised. Google Drive/Docs/Gmail, Notion, Linear and Cal connectors, provider failover, context compaction, full PDF/image understanding, audio waveform visualization, exhaustive upload-format sniffing/chunked progress, and OS-level process/resource limits remain unimplemented. Restart resume reconstructs a continuation from the persisted transcript/workspace; it does not restore an in-flight upstream connection or exact tool stack. See `README.md`, `docs/DECISIONS.md`, and `docs/SECURITY.md` for details.
