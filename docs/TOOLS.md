# Agent tools

Every model-exposed tool validates arguments with Zod before execution. A tool error is returned to the model as a normal JSON result with a message and recovery hint where available.

- `bash` — execute a command in the session workspace; high-impact command patterns require explicit approval; stdout/stderr are captured and bounded
- `read_file` — read a confined UTF-8 file, optionally with a 1-based line range; binary files return a hex preview
- `write_file` — create or overwrite a workspace file and emit `file_changed`
- `edit_file` — replace a unique exact string; ambiguous matches are reported rather than silently changed
- `present_file` — persist an artifact record and focus the Files viewer
- `web_search` — query the DuckDuckGo HTML results interface and return real result URLs
- `fetch_page` — fetch a public HTTP(S) URL, strip common non-content elements, and block private/local addresses
- `image_search` — query Wikimedia Commons, download result images into `assets/search/`, and return attribution/license metadata
- `generate_image` — call the selected provider's OpenAI-compatible image generation or editing endpoint and save returned assets in `assets/generated/`
- `generate_speech` — call the selected provider's OpenAI-compatible text-to-speech endpoint (up to 1,500 characters) and save the resulting audio
- `ask_user` — persist a pending question and wait for an answer while the process remains active
- `todo_write` — update the live plan checklist
- `git_status` — inspect a bound session repository's status and recent commits
- `git_diff` — inspect working-tree or full-branch changes
- `git_commit` — stage and create a conventional commit with an ephemeral local identity
- `git_push` — push the branch; on non-fast-forward, fetch/rebase and retry once
- `create_pull_request` — push and create the single allowed PR for this session through GitHub REST
- `list_pull_requests`, `merge_pull_request`, `get_check_runs` — query/manage PRs and inspect CI state
- `start_preview` — start a real command in the session workspace, wait for loopback HTTP readiness, and publish a proxied preview
- `stop_preview` — stop one or all managed session preview processes

- `notion_search` — search the connected Notion workspace (requires a validated integration token in Settings → Connectors)
- `linear_issues` — list recent issues from the connected Linear workspace
- `google_drive_search` / `google_docs_search` — search Drive files / Google Docs in the connected Google account (OAuth access token)
- `gmail_list` — list recent Gmail metadata (subject/from/snippet) from the connected account
- `google_calendar_events` — list upcoming events from the connected Google Calendar

`read_file` additionally extracts text from PDFs (uncompressed/FlateDecode
streams) and returns image dimensions/format from file headers.

GitHub tools require a connected PAT and a repository bound to that chat session. Preview commands execute as the OS user in the workspace; they are local processes, not OS-isolated containers. Image and speech generation require a provider endpoint that actually supports those APIs. Image generation uses the selected session provider/model and may be rejected by chat-only providers; it is not simulated. Third-party productivity connectors are not implemented and are not presented as connected.
