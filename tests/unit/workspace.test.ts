import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  assertConfined,
  ensureFile,
  listTree,
  safePath,
} from "../../server/src/workspace.js";

const tempDirs: string[] = [];
async function makeDir() {
  const path = await mkdtemp(join(tmpdir(), "galaxy-agent-test-"));
  tempDirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace filesystem", () => {
  it("rejects lexical parent traversal", () => {
    const root = resolve("/tmp/session-root");
    expect(() => safePath(root, "../escape.txt")).toThrow(/outside/);
  });
  it("writes nested files and returns workspace-relative metadata", async () => {
    const root = await makeDir();
    const result = await ensureFile(root, "reports/brief.md", "# Brief");
    expect(result.path).toBe("reports/brief.md");
    expect(result.created).toBe(true);
    expect(await readFile(join(root, "reports/brief.md"), "utf8")).toBe(
      "# Brief",
    );
  });
  it("rejects symlinks that resolve outside the session root", async () => {
    const root = await makeDir();
    const outside = await makeDir();
    await writeFile(join(outside, "secret.txt"), "private");
    await symlink(outside, join(root, "escape"));
    await expect(
      assertConfined(root, join(root, "escape", "secret.txt")),
    ).rejects.toThrow(/outside/);
  });
  it("omits ignored dependencies and symlinks from the workspace tree", async () => {
    const root = await makeDir();
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "noise.txt"), "x");
    await writeFile(join(root, "keep.md"), "ok");
    const outside = await makeDir();
    await symlink(outside, join(root, "linked"));
    const tree = await listTree(root);
    expect(tree.map((f) => f.path)).toEqual(["keep.md"]);
  });
});
