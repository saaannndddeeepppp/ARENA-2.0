import { afterAll, describe, expect, it } from "vitest";
import { createSession, db } from "../../server/src/db.js";
import { openAITools, runTool } from "../../server/src/tools.js";
import { readFile, rm } from "node:fs/promises";
import { workspacePath } from "../../server/src/workspace.js";

const signal = new AbortController().signal;
afterAll(() => db.close());

describe("workspace tool execution", () => {
  it("writes and reads an actual workspace file", async () => {
    const session = createSession("test write/read");
    const written = await runTool(
      "write_file",
      { sessionId: session.id, signal },
      { path: "note.txt", content: "Persistent local data" },
    );
    expect(written).toMatchObject({ path: "note.txt", created: true });
    const read = await runTool(
      "read_file",
      { sessionId: session.id, signal },
      { path: "note.txt" },
    );
    expect(JSON.stringify(read)).toContain("Persistent local data");
    await rm(workspacePath(session.id), { recursive: true, force: true });
    db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  });
  it("applies an exact unique edit without changing unrelated text", async () => {
    const session = createSession("test edit");
    await runTool(
      "write_file",
      { sessionId: session.id, signal },
      { path: "src.txt", content: "alpha\nold value\nomega\n" },
    );
    const result = await runTool(
      "edit_file",
      { sessionId: session.id, signal },
      { path: "src.txt", old_string: "old value", new_string: "new value" },
    );
    expect(result).toMatchObject({ strategy: "exact", replacements: 1 });
    expect(await readFile(`${workspacePath(session.id)}/src.txt`, "utf8")).toBe(
      "alpha\nnew value\nomega\n",
    );
    await rm(workspacePath(session.id), { recursive: true, force: true });
    db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  });
  it("runs a bounded real shell command and captures output", async () => {
    const session = createSession("test shell");
    const result = (await runTool(
      "bash",
      { sessionId: session.id, signal },
      { command: "printf shell-works", timeout: 5000 },
    )) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shell-works");
    await rm(workspacePath(session.id), { recursive: true, force: true });
    db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  });
  it("rejects an attempted workspace escape", async () => {
    const session = createSession("test traversal");
    const result = (await runTool(
      "read_file",
      { sessionId: session.id, signal },
      { path: "../../etc/passwd" },
    )) as { error: boolean };
    expect(result.error).toBe(true);
    await rm(workspacePath(session.id), { recursive: true, force: true });
    db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  });
  it("exposes real media tools and explains missing provider prerequisites", async () => {
    const names = openAITools.map((entry) => entry.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "image_search",
        "generate_image",
        "generate_speech",
      ]),
    );
    const session = createSession("test media prerequisites");
    const result = (await runTool(
      "generate_image",
      { sessionId: session.id, signal },
      { prompt: "A small blue cabin" },
    )) as { error: boolean; message: string };
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/provider/i);
    await rm(workspacePath(session.id), { recursive: true, force: true });
    db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  });
});
