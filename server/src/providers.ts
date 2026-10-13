import { db, id, now } from "./db.js";
import { decrypt, encrypt, maskSecret } from "./crypto.js";
import { z } from "zod";

export type ProviderKind =
  | "openai"
  | "openrouter"
  | "kilo"
  | "custom-openai"
  | "ollama"
  | "gemini"
  | "anthropic"
  | "gemini-openai"
  | "demo";
export type ModelInfo = {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  raw?: unknown;
};
type ProviderRow = {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key_enc: string;
  headers_json: string;
  models_json: string;
  models_fetched_at: number | null;
  enabled: number;
  is_default: number;
  created_at: number;
};
type ToolCall = { id: string; name: string; arguments: string };
type StreamResult = {
  text: string;
  toolCalls: ToolCall[];
  usage: { prompt: number; completion: number };
  latency: number;
};

const providerSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum([
    "openai",
    "openrouter",
    "kilo",
    "custom-openai",
    "ollama",
    "gemini",
    "anthropic",
    "gemini-openai",
    "demo",
  ]),
  base_url: z.string().url(),
  api_key: z.string().optional(),
  headers: z.record(z.string()).optional(),
});
const defaults: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  kilo: "https://api.kilo.ai/api/gateway",
  ollama: "http://localhost:11434/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
  "gemini-openai": "https://generativelanguage.googleapis.com/v1beta/openai",
  "custom-openai": "http://localhost:1234/v1",
  demo: "demo://offline",
};

export function getProviders() {
  return (
    db
      .prepare("SELECT * FROM providers ORDER BY is_default DESC,created_at")
      .all() as ProviderRow[]
  ).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    base_url: p.base_url,
    api_key_masked: maskSecret(p.api_key_enc ? decrypt(p.api_key_enc) : ""),
    headers: JSON.parse(p.headers_json),
    models: JSON.parse(p.models_json),
    models_fetched_at: p.models_fetched_at,
    enabled: Boolean(p.enabled),
    is_default: Boolean(p.is_default),
  }));
}
export function providerSecret(provider: ProviderRow): string {
  return provider.api_key_enc ? decrypt(provider.api_key_enc) : "";
}
export function getProvider(providerId: string): ProviderRow {
  const provider = db
    .prepare("SELECT * FROM providers WHERE id=?")
    .get(providerId) as ProviderRow | undefined;
  if (!provider) throw new Error("Provider not found.");
  return provider;
}
export function saveProvider(input: unknown, providerId?: string) {
  const data = providerSchema.parse(input);
  if (providerId) {
    const old = getProvider(providerId);
    const secret =
      data.api_key === undefined ? old.api_key_enc : encrypt(data.api_key);
    db.prepare(
      "UPDATE providers SET name=?,kind=?,base_url=?,api_key_enc=?,headers_json=? WHERE id=?",
    ).run(
      data.name,
      data.kind,
      data.base_url,
      secret,
      JSON.stringify(data.headers ?? JSON.parse(old.headers_json)),
      providerId,
    );
    return providerId;
  }
  const newId = id();
  db.prepare(
    "INSERT INTO providers(id,name,kind,base_url,api_key_enc,headers_json,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    newId,
    data.name,
    data.kind,
    data.base_url,
    encrypt(data.api_key ?? ""),
    JSON.stringify(data.headers ?? {}),
    now(),
  );
  return newId;
}
export function deleteProvider(providerId: string) {
  if (getProvider(providerId).is_default)
    throw new Error(
      "Choose another default provider before deleting this one.",
    );
  db.prepare("DELETE FROM providers WHERE id=?").run(providerId);
}
export function setDefault(providerId: string) {
  getProvider(providerId);
  db.transaction(() => {
    db.prepare("UPDATE providers SET is_default=0").run();
    db.prepare("UPDATE providers SET is_default=1 WHERE id=?").run(providerId);
  })();
}
function authHeaders(provider: ProviderRow): Record<string, string> {
  const headers: Record<string, string> = {
    ...(JSON.parse(provider.headers_json) as Record<string, string>),
  };
  const key = providerSecret(provider);
  if (key) {
    if (provider.kind === "gemini") headers["x-goog-api-key"] = key;
    else if (provider.kind === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}
function normalizeModels(
  provider: ProviderRow,
  records: Array<Record<string, unknown>>,
): ModelInfo[] {
  return records
    .map((model) => {
      const pricing = model.pricing as Record<string, unknown> | undefined;
      const architecture = model.architecture as
        Record<string, unknown> | undefined;
      const modalities = architecture?.input_modalities as string[] | undefined;
      const rawId = String(model.id ?? model.name ?? "");
      const modelId =
        provider.kind === "gemini" ? rawId.replace(/^models\//, "") : rawId;
      const inputPrice = Number(pricing?.prompt);
      const outputPrice = Number(pricing?.completion);
      const supported = model.supported_parameters as string[] | undefined;
      const generationMethods = model.supportedGenerationMethods as
        string[] | undefined;
      return {
        id: modelId,
        displayName: String(
          model.displayName ??
            model.name ??
            modelId.split("/").at(-1) ??
            modelId,
        ).replace(/^models\//, ""),
        ...(Number(model.context_length ?? model.inputTokenLimit) > 0
          ? {
              contextWindow: Number(
                model.context_length ?? model.inputTokenLimit,
              ),
            }
          : {}),
        supportsTools: Array.isArray(supported)
          ? supported.includes("tools")
          : provider.kind === "gemini"
            ? Boolean(generationMethods?.includes("generateContent"))
            : true,
        supportsVision:
          Boolean(modalities?.includes("image")) ||
          /vision|image/i.test(modelId),
        supportsReasoning:
          Array.isArray(supported) &&
          (supported.includes("reasoning") ||
            supported.includes("include_reasoning")),
        ...(Number.isFinite(inputPrice) && inputPrice >= 0
          ? { inputPricePer1M: inputPrice * 1_000_000 }
          : {}),
        ...(Number.isFinite(outputPrice) && outputPrice >= 0
          ? { outputPricePer1M: outputPrice * 1_000_000 }
          : {}),
        raw: model,
      };
    })
    .filter((model) => model.id);
}
// 424 (Failed Dependency), not 502: some reverse proxies replace the body
// of upstream 502 responses with their own error page, which would hide
// the actionable message below from the UI.
const badGateway = (message: string) =>
  Object.assign(new Error(message), { statusCode: 424 });

export const DEMO_MODELS: ModelInfo[] = [
  {
    id: "galaxy-demo-concise",
    displayName: "Galaxy Demo · Concise (offline)",
    contextWindow: 32000,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
  },
  {
    id: "galaxy-demo-detailed",
    displayName: "Galaxy Demo · Detailed (offline)",
    contextWindow: 32000,
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
  },
];

/** Keyless, offline provider so the full UI/agent loop can be tried where
 * outbound LLM APIs are unreachable. It never touches the network. */
function demoPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content))
      return m.content
        .map((part: any) =>
          typeof part === "string" ? part : (part?.text ?? ""),
        )
        .join(" ")
        .trim();
  }
  return "";
}

async function demoStream(
  model: string,
  messages: Array<Record<string, unknown>>,
  signal: AbortSignal,
  onText: (chunk: string) => void,
): Promise<StreamResult> {
  const started = Date.now();
  const prompt = demoPrompt(messages).slice(0, 900) || "your request";
  const detailed = model.includes("detailed");
  const text = detailed
    ? `**Demo response (offline model)**\n\nYou asked: "${prompt}"\n\nHere is how a real model would approach this:\n\n1. **Understand** — restate the goal and note any constraints in the request.\n2. **Plan** — break the work into small, verifiable steps.\n3. **Execute** — in Agent Mode a real provider would call workspace tools (files, shell, web) to do the work; this offline demo cannot run tools.\n4. **Verify** — check the result and summarise what changed.\n\n_Connect a real provider (OpenRouter, Kilo, OpenAI…) from a network that can reach it, and this same flow runs for real._`
    : `**Demo response (offline model)** — you asked: "${prompt}"\n\nThis is a short built-in reply so you can try the chat, modes and Battle/Side-by-Side flows without internet. Connect a real provider and ask again for a full answer.`;
  const chunks = text.match(/[\s\S]{1,28}/g) ?? [text];
  for (const chunk of chunks) {
    if (signal.aborted) break;
    onText(chunk);
    await new Promise((r) => setTimeout(r, 6));
  }
  const shown = signal.aborted ? "" : text;
  return {
    text: shown,
    toolCalls: [],
    usage: {
      prompt: Math.ceil(prompt.length / 4),
      completion: Math.ceil(shown.length / 4),
    },
    latency: Date.now() - started,
  };
}

/** Demo providers need no API key; every other kind does. */
export function providerUsable(provider: ProviderRow): boolean {
  return provider.kind === "demo" || Boolean(providerSecret(provider));
}

export async function fetchModels(providerId: string): Promise<ModelInfo[]> {
  const provider = getProvider(providerId);
  if (provider.kind === "demo") {
    db.prepare(
      "UPDATE providers SET models_json=?,models_fetched_at=? WHERE id=?",
    ).run(JSON.stringify(DEMO_MODELS), now(), providerId);
    return DEMO_MODELS;
  }
  const headers = authHeaders(provider);
  let url = `${provider.base_url.replace(/\/$/, "")}/models`;
  if (provider.kind === "openrouter")
    url += "?output_modalities=all&limit=1000";
  const catalog: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 10 && url; page++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      const cause =
        error instanceof Error ? (error.cause ?? error.message) : error;
      throw badGateway(
        `Could not reach ${provider.name} at ${provider.base_url} (${String(cause)}). ` +
          "Check that the provider server is running and the base URL is correct " +
          "(OpenAI-compatible URLs usually end with /v1). Note the URL is contacted " +
          "from this app's server, so localhost means the server machine.",
      );
    }
    const body = await response.text();
    if (!response.ok)
      throw badGateway(
        `${provider.name} rejected the model list request (HTTP ${response.status})` +
          (response.status === 401 || response.status === 403
            ? " — the API key looks invalid or missing."
            : ".") +
          (body ? ` Provider said: ${body.slice(0, 300)}` : ""),
      );
    let json: {
      data?: unknown[];
      models?: unknown[];
      links?: { next?: string };
    };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      throw badGateway(
        `${provider.name} at ${provider.base_url} did not return a JSON model list. Is the base URL correct (OpenAI-compatible URLs usually end with /v1)?`,
      );
    }
    catalog.push(
      ...((json.data ?? json.models ?? []) as Array<Record<string, unknown>>),
    );
    url = provider.kind === "openrouter" ? String(json.links?.next ?? "") : "";
  }
  const models = normalizeModels(provider, catalog);
  db.prepare(
    "UPDATE providers SET models_json=?,models_fetched_at=? WHERE id=?",
  ).run(JSON.stringify(models), now(), providerId);
  return models;
}
export function cachedModels(provider: ProviderRow): ModelInfo[] {
  try {
    return JSON.parse(provider.models_json) as ModelInfo[];
  } catch {
    return [];
  }
}

export async function chatStream(
  provider: ProviderRow,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  signal: AbortSignal,
  reasoning = "medium",
  onText: (chunk: string) => void,
): Promise<StreamResult> {
  if (provider.kind === "demo")
    return demoStream(model, messages, signal, onText);
  if (provider.kind === "gemini")
    return nativeGeminiStream(provider, model, messages, tools, signal, onText);
  if (provider.kind === "anthropic")
    return anthropicStream(provider, model, messages, tools, signal, onText);
  const headers = {
    ...authHeaders(provider),
    "Content-Type": "application/json",
  };
  const payload = {
    model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: reasoning,
  };
  const started = Date.now();
  const response = await fetch(
    `${provider.base_url.replace(/\/$/, "")}/chat/completions`,
    { method: "POST", headers, body: JSON.stringify(payload), signal },
  );
  if (!response.ok)
    throw new Error(
      `Provider returned ${response.status}: ${(await response.text()).slice(0, 1000)}`,
    );
  if (!response.body) throw new Error("Provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "",
    text = "",
    prompt = 0,
    completion = 0;
  const calls = new Map<number, ToolCall>();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const usage = item.usage as Record<string, unknown> | undefined;
      if (usage) {
        prompt = Number(usage.prompt_tokens ?? prompt);
        completion = Number(usage.completion_tokens ?? completion);
      }
      const choices = item.choices as
        Array<Record<string, unknown>> | undefined;
      const delta = (choices?.[0]?.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string") {
        text += delta.content;
        onText(delta.content);
      }
      for (const entry of (delta.tool_calls as
        Array<Record<string, unknown>> | undefined) ?? []) {
        const index = Number(entry.index ?? 0);
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof entry.id === "string") current.id = entry.id;
        const fn = entry.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === "string") current.name += fn.name;
        if (typeof fn?.arguments === "string")
          current.arguments += fn.arguments;
        calls.set(index, current);
      }
    }
  }
  return {
    text,
    toolCalls: [...calls.values()],
    usage: { prompt, completion },
    latency: Date.now() - started,
  };
}
async function nativeGeminiStream(
  provider: ProviderRow,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<StreamResult> {
  const key = providerSecret(provider);
  const endpoint = `${provider.base_url.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  const system = messages.find((message) => message.role === "system");
  const callNames = new Map<string, string>();
  for (const message of messages)
    for (const call of (message.tool_calls ?? []) as Array<
      Record<string, unknown>
    >) {
      const fn = call.function as Record<string, unknown> | undefined;
      if (typeof call.id === "string" && typeof fn?.name === "string")
        callNames.set(call.id, fn.name);
    }
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const name = callNames.get(String(message.tool_call_id)) ?? "tool_result";
      let result: unknown = message.content;
      try {
        result = JSON.parse(String(message.content));
      } catch {
        /* plain text tool output is valid */
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: { result } } }],
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof message.content === "string" && message.content)
        parts.push({ text: message.content });
      for (const call of message.tool_calls as Array<Record<string, unknown>>) {
        const fn = call.function as Record<string, unknown> | undefined;
        let args: unknown = {};
        try {
          args = JSON.parse(String(fn?.arguments ?? "{}"));
        } catch {
          /* model response is revalidated by tool dispatcher */
        }
        parts.push({ functionCall: { name: fn?.name, args } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content ?? "") }],
    });
  }
  const declarations = tools.map((entry) => {
    const fn = (entry as { function?: Record<string, unknown> }).function ?? {};
    return {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    };
  });
  const payload = {
    contents,
    ...(system
      ? { systemInstruction: { parts: [{ text: String(system.content) }] } }
      : {}),
    generationConfig: { maxOutputTokens: 4096 },
    ...(declarations.length
      ? { tools: [{ functionDeclarations: declarations }] }
      : {}),
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...authHeaders(provider), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Gemini returned ${response.status}: ${(await response.text()).slice(0, 700)}`,
    );
  if (!response.body) throw new Error("Gemini stream unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "",
    text = "",
    prompt = 0,
    completion = 0;
  const toolCalls: ToolCall[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const item = JSON.parse(line.slice(5)) as Record<string, unknown>;
        const candidates = item.candidates as
          Array<Record<string, unknown>> | undefined;
        const content = candidates?.[0]?.content as
          Record<string, unknown> | undefined;
        for (const part of (content?.parts ?? []) as Array<
          Record<string, unknown>
        >) {
          if (typeof part.text === "string") {
            text += part.text;
            onText(part.text);
          }
          if (part.functionCall) {
            const fn = part.functionCall as Record<string, unknown>;
            toolCalls.push({
              id: id(),
              name: String(fn.name),
              arguments: JSON.stringify(fn.args ?? {}),
            });
          }
        }
        const usage = item.usageMetadata as Record<string, unknown> | undefined;
        if (usage) {
          prompt = Number(usage.promptTokenCount ?? prompt);
          completion = Number(usage.candidatesTokenCount ?? completion);
        }
      } catch {
        /* incomplete or non-data event */
      }
    }
  }
  return { text, toolCalls, usage: { prompt, completion }, latency: 0 };
}
async function anthropicStream(
  provider: ProviderRow,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<StreamResult> {
  const system = String(
    messages.find((message) => message.role === "system")?.content ?? "",
  );
  const payloadMessages: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      payloadMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(message.tool_call_id),
            content: String(message.content ?? ""),
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const blocks: Array<Record<string, unknown>> = [];
      if (typeof message.content === "string" && message.content)
        blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls as Array<Record<string, unknown>>) {
        const fn = call.function as Record<string, unknown> | undefined;
        let input: unknown = {};
        try {
          input = JSON.parse(String(fn?.arguments ?? "{}"));
        } catch {
          /* rejected by tool validation */
        }
        blocks.push({ type: "tool_use", id: call.id, name: fn?.name, input });
      }
      payloadMessages.push({ role: "assistant", content: blocks });
      continue;
    }
    payloadMessages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content ?? ""),
    });
  }
  const declarations = tools.map((entry) => {
    const fn = (entry as { function?: Record<string, unknown> }).function ?? {};
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters,
    };
  });
  const response = await fetch(
    `${provider.base_url.replace(/\/$/, "")}/messages`,
    {
      method: "POST",
      headers: {
        ...authHeaders(provider),
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system,
        messages: payloadMessages,
        max_tokens: 4096,
        stream: true,
        ...(declarations.length ? { tools: declarations } : {}),
      }),
      signal,
    },
  );
  if (!response.ok)
    throw new Error(
      `Anthropic returned ${response.status}: ${(await response.text()).slice(0, 800)}`,
    );
  if (!response.body) throw new Error("Anthropic stream was empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "",
    text = "",
    prompt = 0,
    completion = 0;
  const calls = new Map<number, ToolCall>();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const item = JSON.parse(line.slice(5).trim()) as Record<
          string,
          unknown
        >;
        const type = String(item.type ?? "");
        if (type === "message_start") {
          const message = item.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, unknown> | undefined;
          prompt = Number(usage?.input_tokens ?? 0);
        }
        if (type === "content_block_start") {
          const block = item.content_block as
            Record<string, unknown> | undefined;
          if (block?.type === "tool_use")
            calls.set(Number(item.index ?? 0), {
              id: String(block.id),
              name: String(block.name),
              arguments: "",
            });
        }
        if (type === "content_block_delta") {
          const delta = item.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
            onText(delta.text);
          }
          if (delta?.type === "input_json_delta") {
            const call = calls.get(Number(item.index ?? 0));
            if (call) call.arguments += String(delta.partial_json ?? "");
          }
        }
        if (type === "message_delta") {
          const usage = item.usage as Record<string, unknown> | undefined;
          completion = Number(usage?.output_tokens ?? completion);
        }
      } catch {
        /* incomplete SSE event */
      }
    }
  }
  return {
    text,
    toolCalls: [...calls.values()],
    usage: { prompt, completion },
    latency: 0,
  };
}
export function providerDefaults() {
  return defaults;
}
