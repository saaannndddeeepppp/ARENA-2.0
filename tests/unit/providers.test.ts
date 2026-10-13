import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../server/src/db.js";
import {
  chatStream,
  getProvider,
  saveProvider,
} from "../../server/src/providers.js";

type Provider = Parameters<typeof chatStream>[0];
const ids: string[] = [];
function addProvider(kind: "custom-openai" | "anthropic" | "gemini") {
  const base_url =
    kind === "custom-openai"
      ? "http://127.0.0.1:9981/v1"
      : kind === "anthropic"
        ? "https://example.invalid/v1"
        : "https://example.invalid/v1beta";
  const id = saveProvider({ name: `test-${kind}`, kind, base_url });
  ids.push(id);
  return getProvider(id) as Provider;
}
function streamResponse(text: string) {
  const chunks = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(chunks);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  for (const id of ids) db.prepare("DELETE FROM providers WHERE id=?").run(id);
  db.close();
});

describe("provider protocol adapters", () => {
  it("streams OpenAI-compatible text and assembles fragmented tool arguments", async () => {
    const provider = addProvider("custom-openai");
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "bash", arguments: '{"command":' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"true"}' } }] } }] })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 }, choices: [{ delta: {} }] })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(body)));
    const deltas: string[] = [];
    const result = await chatStream(
      provider,
      "live-model",
      [{ role: "user", content: "hello" }],
      [],
      signal,
      "low",
      (delta) => deltas.push(delta),
    );
    expect(result.text).toBe("Hello");
    expect(result.toolCalls).toEqual([
      { id: "call-1", name: "bash", arguments: '{"command":"true"}' },
    ]);
    expect(result.usage).toEqual({ prompt: 7, completion: 3 });
    expect(deltas).toEqual(["Hello"]);
  });

  it("parses Anthropic text and tool-use SSE blocks", async () => {
    const provider = addProvider("anthropic");
    const body = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 6 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "anthropic-call", name: "bash", input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"true"}' } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "done" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}`,
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(body)));
    const result = await chatStream(
      provider,
      "claude-model",
      [{ role: "user", content: "run it" }],
      [],
      signal,
      "medium",
      () => {},
    );
    expect(result.text).toBe("done");
    expect(result.toolCalls).toEqual([
      { id: "anthropic-call", name: "bash", arguments: '{"command":"true"}' },
    ]);
    expect(result.usage).toEqual({ prompt: 6, completion: 2 });
  });

  it("normalizes native Gemini text and function calls", async () => {
    const provider = addProvider("gemini");
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini" }, { functionCall: { name: "todo_write", args: { todos: [] } } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(body)));
    const result = await chatStream(
      provider,
      "models-live-name",
      [{ role: "user", content: "plan" }],
      [],
      signal,
      "medium",
      () => {},
    );
    expect(result.text).toBe("Gemini");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("todo_write");
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ todos: [] });
    expect(result.usage).toEqual({ prompt: 5, completion: 4 });
  });
});
