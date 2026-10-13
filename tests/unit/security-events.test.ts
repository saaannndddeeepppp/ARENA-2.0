import { afterAll, describe, expect, it } from "vitest";
import { decrypt, encrypt, maskSecret } from "../../server/src/crypto.js";
import { eventBus } from "../../server/src/events.js";
import { createSession, db } from "../../server/src/db.js";

afterAll(() => {
  db.prepare("DELETE FROM sessions WHERE title='event-test'").run();
  db.close();
});

describe("local secret encryption", () => {
  it("round-trips encrypted credentials and does not store the plaintext", () => {
    const secret = "provider-secret-12345";
    const encoded = encrypt(secret);
    expect(encoded).not.toContain(secret);
    expect(decrypt(encoded)).toBe(secret);
  });
  it("masks a credential while retaining a small identifying prefix and suffix", () => {
    expect(maskSecret("sk-abcdefgh1234")).toBe("sk-…1234");
    expect(maskSecret("")).toBe("");
  });
  it("rejects malformed encrypted data", () => {
    expect(() => decrypt("not.a.valid.iv.layout")).toThrow();
  });
});

describe("session event replay", () => {
  it("assigns increasing sequence numbers and replays events after a cursor", () => {
    const bus = eventBus(createSession("event-test").id);
    bus.publish("text_delta", { delta: "a" });
    bus.publish("tool_start", { name: "bash" });
    bus.publish("text_delta", { delta: "b" });
    expect(bus.replay(1).map((e) => e.type)).toEqual([
      "tool_start",
      "text_delta",
    ]);
    expect(bus.latest()).toBe(3);
  });
  it("bounds the durable replay ring to 2000 events", () => {
    const bus = eventBus(createSession("event-test").id);
    for (let i = 0; i < 2002; i++) bus.publish("heartbeat", { i });
    expect(bus.replay(0)).toHaveLength(2000);
    expect(bus.oldest()).toBe(3);
  });
  it("delivers live events to current subscribers and persists them", () => {
    const session = createSession("event-test");
    const bus = eventBus(session.id);
    const received: string[] = [];
    const off = bus.subscribe((event) => received.push(event.type));
    bus.publish("turn_end", { turn: 1 });
    off();
    expect(received).toEqual(["turn_end"]);
    expect(
      db
        .prepare("SELECT type FROM session_events WHERE session_id=?")
        .get(session.id),
    ).toEqual({ type: "turn_end" });
  });
});
