import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../server/src/db.js";
import {
  githubConnect,
  githubDisconnect,
  githubListRepos,
  githubSelectRepos,
  githubStatus,
} from "../../server/src/github.js";

const pat = `ghp_${"x".repeat(36)}`;
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-RateLimit-Remaining": "42",
    },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  db.prepare("DELETE FROM connectors WHERE id='github'").run();
});

describe("GitHub integration", () => {
  it("validates a PAT, lists repositories, and persists only encrypted credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ login: "test-user", name: "Test User" }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 1,
            full_name: "test-user/demo",
            name: "demo",
            owner: { login: "test-user" },
            default_branch: "main",
            private: false,
            html_url: "https://github.com/test-user/demo",
            description: null,
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await githubConnect(pat);
    expect(result.connected).toBe(true);
    expect(result.repositories).toHaveLength(1);
    const stored = db
      .prepare("SELECT credential_enc FROM connectors WHERE id='github'")
      .get() as { credential_enc: string };
    expect(stored.credential_enc).not.toContain(pat);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/user");
  });
  it("persists selected repository names and preserves them on disconnect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ login: "test-user" }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await githubConnect(pat);
    githubSelectRepos(["test-user/demo"]);
    const result = githubDisconnect();
    expect(result.selectedRepos).toEqual(["test-user/demo"]);
    expect((await githubStatus()).connected).toBe(false);
    expect((await githubStatus()).selectedRepos).toEqual(["test-user/demo"]);
  });
  it("surfaces an invalid token response without storing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: "Bad credentials" }, 401)),
    );
    await expect(githubConnect(pat)).rejects.toThrow(/401.*Bad credentials/);
    expect(
      db.prepare("SELECT id FROM connectors WHERE id='github'").get(),
    ).toBeUndefined();
  });
  it("requests user repository pagination with the documented affiliation filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    db.prepare(
      "INSERT INTO connectors(id,credential_enc,config_json,updated_at) VALUES('github',?,?,?)",
    ).run("ciphertext", "{}", Date.now());
    // Stub decryption by using a test-created encrypted credential through the connect flow.
    const { encrypt } = await import("../../server/src/crypto.js");
    db.prepare("UPDATE connectors SET credential_enc=? WHERE id='github'").run(
      encrypt(pat),
    );
    await githubListRepos();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "affiliation=owner,collaborator,organization_member",
    );
  });
});
