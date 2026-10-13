import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../server/src/db.js";
import {
  connectConnector,
  disconnectConnector,
  listConnectors,
} from "../../server/src/connectors.js";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const id of ["notion", "linear", "drive", "gdocs", "gmail", "cal"])
    db.prepare("DELETE FROM connectors WHERE id=?").run(id);
});

describe("connectors", () => {
  it("lists all connectors as disconnected by default without leaking tokens", () => {
    const list = listConnectors();
    expect(list.map((c) => c.id)).toEqual([
      "notion",
      "drive",
      "gdocs",
      "gmail",
      "linear",
      "cal",
    ]);
    expect(list.every((c) => !c.connected && !c.credentialMasked)).toBe(true);
  });
  it("validates a Notion token against the real API shape and stores it encrypted", async () => {
    const token = `ntn_${"x".repeat(30)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ bot: { workspace_name: "Acme HQ" }, name: "Bot" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await connectConnector("notion", token);
    expect(result?.connected).toBe(true);
    expect(result?.account).toBe("Acme HQ");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.notion.com/v1/users/me",
    );
    const stored = db
      .prepare("SELECT credential_enc FROM connectors WHERE id='notion'")
      .get() as { credential_enc: string };
    expect(stored.credential_enc).not.toContain(token);
    expect(
      listConnectors().find((c) => c.id === "notion")?.credentialMasked,
    ).toContain("…");
    expect(
      listConnectors().find((c) => c.id === "notion")?.credentialMasked,
    ).not.toBe(token);
  });
  it("rejects an invalid Linear key and stores nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { errors: [{ message: "Authentication required" }] },
            401,
          ),
        ),
    );
    await expect(
      connectConnector("linear", `lin_api_${"y".repeat(20)}`),
    ).rejects.toThrow(/401|Authentication/);
    expect(
      db.prepare("SELECT id FROM connectors WHERE id='linear'").get(),
    ).toBeUndefined();
  });
  it("disconnect removes the stored credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ emailAddress: "a@example.com", messagesTotal: 3 }),
        ),
    );
    await connectConnector("gmail", `ya29.${"z".repeat(24)}`);
    expect(listConnectors().find((c) => c.id === "gmail")?.connected).toBe(
      true,
    );
    disconnectConnector("gmail");
    expect(listConnectors().find((c) => c.id === "gmail")?.connected).toBe(
      false,
    );
  });
});
