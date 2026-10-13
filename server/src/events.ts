import { EventEmitter } from "node:events";
import { db } from "./db.js";

export type AgentEvent = {
  seq: number;
  type: string;
  data: unknown;
  at: number;
};
const eventLimit = 2000;
class SessionEvents {
  private emitter = new EventEmitter();
  private seq = 0;
  private history: AgentEvent[];
  constructor(private readonly sessionId: string) {
    const rows = db
      .prepare(
        "SELECT seq,type,data_json,created_at FROM session_events WHERE session_id=? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, eventLimit)
      .reverse() as Array<{
      seq: number;
      type: string;
      data_json: string;
      created_at: number;
    }>;
    this.history = rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data_json),
      at: row.created_at,
    }));
    this.seq = rows.at(-1)?.seq ?? 0;
  }
  publish(type: string, data: unknown): AgentEvent {
    const event = { seq: ++this.seq, type, data, at: Date.now() };
    db.prepare(
      "INSERT INTO session_events(session_id,seq,type,data_json,created_at) VALUES(?,?,?,?,?)",
    ).run(
      this.sessionId,
      event.seq,
      type,
      JSON.stringify(data ?? null),
      event.at,
    );
    this.history.push(event);
    if (this.history.length > eventLimit) {
      const removed = this.history.splice(0, this.history.length - eventLimit);
      const cutoff = removed.at(-1)?.seq;
      if (cutoff !== undefined)
        db.prepare(
          "DELETE FROM session_events WHERE session_id=? AND seq<=?",
        ).run(this.sessionId, cutoff);
    }
    this.emitter.emit("event", event);
    return event;
  }
  replay(from: number): AgentEvent[] {
    return this.history.filter((event) => event.seq > from);
  }
  oldest(): number {
    return this.history[0]?.seq ?? this.seq + 1;
  }
  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
  latest(): number {
    return this.seq;
  }
}
const buses = new Map<string, SessionEvents>();
export function eventBus(sessionId: string): SessionEvents {
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = new SessionEvents(sessionId);
    buses.set(sessionId, bus);
  }
  return bus;
}
export function publish(
  sessionId: string,
  type: string,
  data: unknown,
): AgentEvent {
  return eventBus(sessionId).publish(type, data);
}
