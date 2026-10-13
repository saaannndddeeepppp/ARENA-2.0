# UI comparison — original vs this build

Reference: the public Arena Agent page (`https://arena.ai/agent`), captured
in `reference/arena-agent-empty-state.webp` and re-checked live on 2026-10-13
(page title "Experience the frontier", connector row GitHub / Drive / Docs /
Notion / Gmail / Linear / Cal). This build now uses that light, warm
off-white theme as the **default**; the previous dark workspace remains under
Settings → Appearance → Dark.

## Screenshots (kept in repo)

- `reference/comparison-original-vs-clone.png` — side-by-side, both 864×864.
- `reference/clone-home-original-style.png` — clone home, live screenshot.
- `reference/clone-home-1440.png` — clone home at 1440×900.
- `reference/clone-workspace.png` — clone after starting a chat (history
  sidebar + top bar; the right workspace panel opens on demand).
- `reference/clone-settings-connectors.png` — real connector settings.

Screenshots were taken with headless Chromium (via `@sparticuz/chromium` +
`puppeteer-core`) against the production build served on `:4310`.

## What matches the original home

- Warm off-white background (`#fbfaf6`), white composer surface, soft warm
  borders and shadows.
- Narrow 38px left icon rail (new chat, agent/settings actions); history
  expands only once a chat starts.
- Centered column logotype (classical-column glyph + serif "Arena") and the
  serif headline "Experience the _frontier_" with **frontier** italic on the
  signature yellow highlight block.
- Large rounded "Ask anything…" composer: left tune + Agent controls, right
  voice-input + send buttons, attach available in the chat composer.
- One-row connector pills underneath: GitHub, Drive, Docs, Notion, Gmail,
  Linear, Cal — each now shows a green dot when its credential is validated,
  and clicking a pill opens the real connector settings.
- Headline/hero proportions, composer width (~450px) and vertical placement
  were tuned across three screenshot iterations to match the reference.

## Intentional differences (functional, documented)

- An extra muted line "Add a model provider to begin" appears only when no
  model provider is configured — the original is a hosted service, this build
  is local-first and needs a user provider key. It disappears once configured.
- Connector pills use simple geometric glyphs instead of third-party brand
  logos, and the rail shows real actions of this app (new chat, Agent,
  Settings) rather than Links to Arena's leaderboard/history pages, which are
  out of scope for the agent workspace.
- Once a conversation starts, the layout grows the history sidebar, top bar
  and workspace/diff/preview panels that an agent workspace needs; the
  original's logged-in equivalent is behind authentication and its reCAPTCHA
  wall, so the empty state is the verifiable reference.
- Dark theme differs from the original on purpose (user-selectable only).

## Responses / interaction behaviour

Streaming text, tool cards, plan checklist, cost strip, approval and
ask-user cards, SSE reconnect/replay, command palette (Ctrl/⌘+K), slash
commands and keyboard shortcuts behave as before — now also emitting
`context_compacted` and `provider_failover` events, which surface as notices.

## 1.2.0 thread-UX pass (from the user's original-app screenshots)

- Tool calls now render as grouped, collapsible activities ("Ran commands 3", "Edited files 2", "Explored 1 read") with `used Bash ✓ 147ms` rows, and produced files appear as inline cards with extension chips.
- The composer "+" opens the Connections popover (GitHub toggle, Connect actions, "View all connectors", "Add files"), and "View all" opens the Connectors bottom sheet with the same card copy as the original (GitHub, Drive, Docs, Notion, Gmail, Linear, Calendar).
- The mode menu offers Battle Mode (anonymous models until a winner is picked), Agent Mode, Side by Side (two chosen models) and Direct (no-tools chat); all four are functional, not decorative.
- Session titles have a Rename/Archive/Delete context menu (Archive is red, matching the original), and the Workspace panel shows usage counters, a folder tree and a bottom Connectors bar; on small screens it docks as a bottom sheet.
