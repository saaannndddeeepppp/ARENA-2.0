import { describe, expect, it } from "vitest";
import {
  activityFiles,
  fileExtension,
  formatDuration,
  groupActivities,
  toolDisplayName,
  type ActivityTool,
} from "../../web/src/activity.ts";

const t = (patch: Partial<ActivityTool>): ActivityTool => ({
  callId: Math.random().toString(36).slice(2),
  toolName: "bash",
  args: { command: "ls" },
  summary: "run command",
  status: "done",
  ...patch,
});

describe("activity grouping (Galaxy thread style)", () => {
  it("groups consecutive bash calls into 'Ran commands N'", () => {
    const groups = groupActivities([t({}), t({}), t({})]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Ran commands 3");
    expect(groups[0].tools).toHaveLength(3);
  });

  it("labels edits and reads like the original", () => {
    const groups = groupActivities([
      t({ toolName: "write_file", args: { path: "docs/API.md" } }),
      t({ toolName: "edit_file", args: { path: "src/a.ts" } }),
      t({ toolName: "read_file", args: { path: "README.md" } }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Edited files 2",
      "Explored 1 read",
    ]);
    expect(groups[0].filePaths).toEqual(["docs/API.md", "src/a.ts"]);
  });

  it("marks groups running and formats durations", () => {
    const groups = groupActivities([t({ status: "running" })]);
    expect(groups[0].running).toBe(true);
    expect(formatDuration(147)).toBe("147ms");
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(toolDisplayName("bash")).toBe("Bash");
    expect(toolDisplayName("google_calendar_events")).toBe("Calendar events");
  });

  it("collects unique files and extension chips", () => {
    const files = activityFiles([
      t({ toolName: "write_file", args: { path: "docs/API.md" } }),
      t({ toolName: "edit_file", args: { path: "docs/API.md" } }),
      t({ toolName: "bash", args: { path: "ignored.txt" } }),
      t({ toolName: "generate_image", result: { path: "img/x.png" } }),
    ]);
    expect(files).toEqual(["docs/API.md", "img/x.png"]);
    expect(fileExtension("docs/API.md")).toBe("MD");
    expect(fileExtension("a/b/App.tsx")).toBe("TSX");
    expect(fileExtension("LICENSE")).toBe("FILE");
  });
});
