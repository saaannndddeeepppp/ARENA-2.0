import { describe, expect, it } from "vitest";
import { RateLimiter, tokenMatches } from "../../server/src/security.js";
import {
  compactMessages,
  chooseFailoverModel,
  estimateMessagesChars,
} from "../../server/src/agent.js";
import { extractPdfText, imageInfo } from "../../server/src/media.js";

describe("rate limiter", () => {
  it("allows up to the limit then blocks with retry delay", () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.check("a", 0).allowed).toBe(true);
    expect(rl.check("a", 10).allowed).toBe(true);
    expect(rl.check("a", 20).allowed).toBe(true);
    const blocked = rl.check("a", 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(rl.check("b", 30).allowed).toBe(true);
    expect(rl.check("a", 2000).allowed).toBe(true);
  });
});

describe("auth token compare", () => {
  it("matches only the exact token", () => {
    expect(tokenMatches("secret-token-123", "secret-token-123")).toBe(true);
    expect(tokenMatches("secret-token-124", "secret-token-123")).toBe(false);
    expect(tokenMatches(undefined, "secret-token-123")).toBe(false);
    expect(tokenMatches("short", "secret-token-123")).toBe(false);
  });
});

describe("context compaction", () => {
  it("keeps system + first user + recent turns and marks the gap", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "sys" },
      { role: "user", content: "first request" },
    ];
    for (let i = 0; i < 40; i++)
      messages.push({
        role: i % 2 ? "assistant" : "user",
        content: "x".repeat(500),
      });
    const result = compactMessages(messages, 4000, 6);
    expect(result.compacted).toBe(true);
    expect("dropped" in result).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages[0]?.role).toBe("system");
    expect(String(result.messages[2]?.content)).toContain("Context compacted");
    expect(estimateMessagesChars(result.messages)).toBeLessThan(
      estimateMessagesChars(messages),
    );
  });
  it("does not compact small transcripts", () => {
    const result = compactMessages(
      [
        { role: "system", content: "a" },
        { role: "user", content: "hi" },
      ],
      100000,
    );
    expect(result.compacted).toBe(false);
  });
});

describe("failover model choice", () => {
  it("prefers the same model id, else the first catalog model", () => {
    expect(chooseFailoverModel([{ id: "a" }, { id: "b" }], "b")).toBe("b");
    expect(chooseFailoverModel([{ id: "a" }], "zzz")).toBe("a");
    expect(chooseFailoverModel([], "a")).toBeNull();
  });
});

describe("media extraction", () => {
  it("extracts text from an uncompressed PDF stream", () => {
    const stream = "BT /F1 12 Tf (Hello PDF world) Tj ET";
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n%%EOF`,
      "latin1",
    );
    const result = extractPdfText(pdf);
    expect(result.text).toContain("Hello PDF world");
    expect(result.streams).toBe(1);
  });
  it("reads PNG dimensions from the header", () => {
    const buf = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(640, 16);
    buf.writeUInt32BE(480, 20);
    expect(imageInfo(buf)).toEqual({ format: "png", width: 640, height: 480 });
  });
});
