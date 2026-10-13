/**
 * Groups a flat tool-call list into the collapsible activity rows the
 * Galaxy agent thread shows:
 *   "Ran commands 3"  ·  "Edited files 2"  ·  "Explored 1 read"  ·  …
 * Pure and unit-testable (tests/unit/activity.test.ts).
 */

export type ActivityTool = {
  callId: string;
  toolName: string;
  args: any;
  summary: string;
  status: string;
  result?: any;
  durationMs?: number;
};

export type ActivityGroup = {
  key: string;
  kind: string;
  label: string;
  tools: ActivityTool[];
  running: boolean;
  filePaths: string[];
};

const DISPLAY: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  present_file: "Present",
  web_search: "Web search",
  fetch_page: "Fetch page",
  image_search: "Image search",
  generate_image: "Generate image",
  generate_speech: "Generate speech",
  ask_user: "Ask user",
  todo_write: "Plan",
  notion_search: "Notion search",
  linear_issues: "Linear issues",
  google_drive_search: "Drive search",
  google_docs_search: "Docs search",
  gmail_list: "Gmail list",
  google_calendar_events: "Calendar events",
  git_status: "Git status",
  git_diff: "Git diff",
  git_commit: "Git commit",
  git_push: "Git push",
  create_pull_request: "Create PR",
  list_pull_requests: "List PRs",
  merge_pull_request: "Merge PR",
  get_check_runs: "Check runs",
  start_preview: "Start preview",
  stop_preview: "Stop preview",
};

export function toolDisplayName(toolName: string): string {
  return DISPLAY[toolName] ?? toolName;
}

function kindOf(toolName: string): string {
  if (toolName === "bash") return "commands";
  if (toolName === "write_file" || toolName === "edit_file") return "edits";
  if (toolName === "read_file") return "reads";
  if (
    toolName === "web_search" ||
    toolName === "fetch_page" ||
    toolName === "image_search"
  )
    return "research";
  if (
    toolName.startsWith("git_") ||
    toolName.includes("pull_request") ||
    toolName === "get_check_runs"
  )
    return "git";
  return "tools";
}

function labelFor(kind: string, count: number): string {
  switch (kind) {
    case "commands":
      return `Ran commands ${count}`;
    case "edits":
      return `Edited files ${count}`;
    case "reads":
      return `Explored ${count} read${count === 1 ? "" : "s"}`;
    case "research":
      return `Researched ${count}`;
    case "git":
      return `Git operations ${count}`;
    default:
      return `Ran tools ${count}`;
  }
}

function filePathOf(tool: ActivityTool): string | null {
  const candidate =
    tool.args?.path ?? tool.result?.path ?? tool.args?.file ?? null;
  return typeof candidate === "string" && candidate ? candidate : null;
}

export function groupActivities(tools: ActivityTool[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const tool of tools) {
    const kind = kindOf(tool.toolName);
    const last = groups.at(-1);
    if (last && last.kind === kind) {
      last.tools.push(tool);
      last.label = labelFor(kind, last.tools.length);
      last.running = last.tools.some((t) => t.status === "running");
      const path = filePathOf(tool);
      if (path && !last.filePaths.includes(path)) last.filePaths.push(path);
    } else {
      const path = filePathOf(tool);
      groups.push({
        key: `${kind}-${tool.callId}`,
        kind,
        label: labelFor(kind, 1),
        tools: [tool],
        running: tool.status === "running",
        filePaths: path ? [path] : [],
      });
    }
  }
  return groups;
}

/** Unique files touched by completed write/edit/present calls, in order. */
export function activityFiles(tools: ActivityTool[]): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    if (
      !["write_file", "edit_file", "present_file"].includes(tool.toolName) &&
      !tool.result?.path
    )
      continue;
    const path = filePathOf(tool);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export function formatDuration(ms?: number): string {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function fileExtension(path: string): string {
  const ext = path.split(".").pop() ?? "";
  if (!ext || ext === path) return "FILE";
  return ext.slice(0, 5).toUpperCase();
}
