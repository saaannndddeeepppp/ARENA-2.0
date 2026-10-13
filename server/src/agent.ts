import { db, addMessage, getMessages, now } from "./db.js";
import { publish } from "./events.js";
import {
  getProvider,
  providerSecret,
  providerUsable,
  chatStream,
  cachedModels,
} from "./providers.js";
import { openAITools, runTool, agentSystemPrompt } from "./tools.js";
import { workspacePath } from "./workspace.js";
import { config } from "./config.js";
import { randomUUID } from "node:crypto";
import type { SessionRow } from "./db.js";

type ActiveRun = {
  controller: AbortController;
  status: "running" | "awaiting_user";
};
const active = new Map<string, ActiveRun>();
const toolResultMax = 24000;
export function getRunStatus(sessionId: string) {
  const stored = db
    .prepare("SELECT status FROM sessions WHERE id=?")
    .get(sessionId) as { status: string } | undefined;
  if (stored?.status === "awaiting_user") return "awaiting_user";
  return active.get(sessionId)?.status ?? stored?.status ?? "idle";
}
export function stopRun(sessionId: string) {
  const run = active.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  active.delete(sessionId);
  db.prepare("UPDATE sessions SET status=? WHERE id=?").run("idle", sessionId);
  publish(sessionId, "run_stopped", { reason: "user" });
  return true;
}

export function estimateMessagesChars(
  messages: Array<Record<string, unknown>>,
): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += m.content.length;
    else if (m.content != null) total += JSON.stringify(m.content).length;
    if (Array.isArray(m.tool_calls))
      total += JSON.stringify(m.tool_calls).length;
  }
  return total;
}

export type CompactionResult = {
  messages: Array<Record<string, unknown>>;
  compacted: boolean;
  dropped: number;
  beforeChars: number;
  afterChars: number;
};

/**
 * Model-context compaction: when the transcript grows past the configured
 * budget, keep the system prompt, the first user request and the most recent
 * turns, and replace the middle with an explicit summary marker. Oversized
 * tool results are truncated first. This is deterministic (no extra model
 * call) and never drops the latest user turn.
 */
export function compactMessages(
  input: Array<Record<string, unknown>>,
  maxChars = config.contextMaxChars,
  keepRecent = 14,
): CompactionResult {
  const beforeChars = estimateMessagesChars(input);
  const truncated = input.map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > 6000
    )
      return {
        ...m,
        content: `${m.content.slice(0, 6000)}\n[tool result truncated by context compaction]`,
      };
    if (typeof m.content === "string" && m.content.length > 20000)
      return {
        ...m,
        content: `${m.content.slice(0, 20000)}\n[message truncated by context compaction]`,
      };
    return m;
  });
  if (
    estimateMessagesChars(truncated) <= maxChars ||
    truncated.length <= keepRecent + 2
  )
    return {
      messages: truncated,
      compacted: false,
      dropped: 0,
      beforeChars,
      afterChars: estimateMessagesChars(truncated),
    };
  const head = truncated.slice(0, 2); // system + first user turn
  const tail = truncated.slice(-keepRecent);
  const dropped = truncated.length - head.length - tail.length;
  const marker: Record<string, unknown> = {
    role: "system",
    content: `[Context compacted: ${dropped} earlier message(s) were summarised away to fit the model context budget. The original transcript remains in the session history and workspace files are unchanged. Continue from the recent turns below.]`,
  };
  const messages = [...head, marker, ...tail];
  return {
    messages,
    compacted: true,
    dropped,
    beforeChars,
    afterChars: estimateMessagesChars(messages),
  };
}

/** Picks the model to use on a failover provider: same id if offered, else its first catalog model. */
export function chooseFailoverModel(
  models: Array<{ id: string }>,
  preferred: string,
): string | null {
  if (!models.length) return null;
  return models.find((m) => m.id === preferred)?.id ?? models[0]!.id;
}

export type RunMode = "agent" | "direct";
export function runSession(
  session: SessionRow,
  prompt: string,
  providerId: string,
  model: string,
  reasoning = "medium",
  mode: RunMode = "agent",
) {
  if (active.has(session.id))
    throw new Error("This session is already running.");
  const provider = getProvider(providerId);
  if (!provider.enabled) throw new Error("Selected provider is disabled.");
  if (!providerUsable(provider))
    throw new Error(
      "Configure an API key for the selected provider in Settings.",
    );
  const controller = new AbortController();
  active.set(session.id, { controller, status: "running" });
  db.prepare(
    "UPDATE sessions SET status=?,model_provider=?,model_id=? WHERE id=?",
  ).run("running", providerId, model, session.id);
  const userMessage = addMessage(session.id, "user", prompt);
  if (session.title === "New chat")
    db.prepare("UPDATE sessions SET title=? WHERE id=?").run(
      heuristicTitle(prompt),
      session.id,
    );
  publish(session.id, "message_persisted", {
    messageId: userMessage.id,
    role: "user",
  });
  publish(session.id, "run_started", {
    runId: randomUUID(),
    turn: 1,
    startedAt: now(),
  });
  void runLoop(session, provider, model, reasoning, controller, mode)
    .catch((error) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      publish(session.id, "run_error", {
        code: "PROVIDER_UPSTREAM",
        message,
        hint: "Check provider settings and retry the turn.",
        retryable: true,
      });
      db.prepare("UPDATE sessions SET status=? WHERE id=?").run(
        "error",
        session.id,
      );
    })
    .finally(() => {
      active.delete(session.id);
      db.prepare("UPDATE sessions SET status=? WHERE id=? AND status=?").run(
        "idle",
        session.id,
        "running",
      );
    });
  return userMessage;
}
export function resumeInterruptedSession(sessionId: string, answer?: string) {
  const session = db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .get(sessionId) as SessionRow | undefined;
  if (!session) throw new Error("Session not found.");
  if (active.has(sessionId))
    throw new Error("This session is already running.");
  const providerId =
    session.model_provider ??
    (
      db
        .prepare("SELECT id FROM providers WHERE is_default=1 AND enabled=1")
        .get() as { id: string } | undefined
    )?.id;
  if (!providerId)
    throw new Error("Choose a model provider before resuming this session.");
  const provider = getProvider(providerId);
  const model = session.model_id ?? cachedModels(provider)[0]?.id;
  if (!model)
    throw new Error(
      "Select a model from the provider's live catalog before resuming.",
    );
  const original =
    (getMessages(sessionId)
      .filter((message) => message.role === "user")
      .at(-1)?.content as string | undefined) ?? "the prior request";
  const directive = answer
    ? `Resume the interrupted task. The user's answer to your pending question was: ${answer}\n\nReview the existing conversation and workspace, then continue and verify completion. Original task: ${original}`
    : `Resume the interrupted task from the existing conversation and workspace. Determine what was completed before interruption, continue safely, verify the result, and report any remaining work. The last user request was: ${original}`;
  return runSession(session, directive, providerId, model);
}
async function runLoop(
  session: SessionRow,
  provider: ReturnType<typeof getProvider>,
  model: string,
  reasoning: string,
  controller: AbortController,
  mode: RunMode = "agent",
) {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: `${agentSystemPrompt}\nCurrent session: ${session.id}\nWorking directory: ${workspacePath(session.id)}`,
    },
  ];
  for (const message of getMessages(session.id)) {
    if (message.role === "system") continue;
    const role = String(message.role);
    if (role === "ask_user") continue;
    messages.push({ role, content: String(message.content) });
  }
  let callsExecuted = 0;
  let finalText = "";
  let activeProvider = provider;
  let activeModel = model;
  for (
    let iteration = 0;
    iteration < 30 && !controller.signal.aborted;
    iteration++
  ) {
    const compaction = compactMessages(messages, config.contextMaxChars);
    if (compaction.compacted) {
      messages.splice(0, messages.length, ...compaction.messages);
      publish(session.id, "context_compacted", {
        dropped: compaction.dropped,
        beforeChars: compaction.beforeChars,
        afterChars: compaction.afterChars,
      });
    }
    const attempt = await chatWithFailover(
      session.id,
      activeProvider,
      activeModel,
      messages,
      controller,
      reasoning,
      mode,
    );
    activeProvider = attempt.provider;
    activeModel = attempt.model;
    const result = attempt.result;
    finalText = result.text;
    const toolCalls = result.toolCalls;
    const assistantRecord = addMessage(
      session.id,
      "assistant",
      finalText,
      toolCalls.length ? toolCalls : undefined,
    );
    publish(session.id, "text_done", {
      fullText: finalText,
      messageId: assistantRecord.id,
    });
    publish(session.id, "message_persisted", {
      messageId: assistantRecord.id,
      role: "assistant",
    });
    messages.push({
      role: "assistant",
      content: finalText || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    });
    const modelInfo = cachedModels(activeProvider).find(
      (entry) => entry.id === activeModel,
    );
    const cost = Number(
      (
        (result.usage.prompt * (modelInfo?.inputPricePer1M ?? 0) +
          result.usage.completion * (modelInfo?.outputPricePer1M ?? 0)) /
        1_000_000
      ).toFixed(8),
    );
    db.prepare(
      "INSERT INTO costs(id,session_id,turn,provider,model,prompt_tokens,completion_tokens,cost_usd,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      session.id,
      iteration + 1,
      activeProvider.id,
      activeModel,
      result.usage.prompt,
      result.usage.completion,
      cost,
      result.latency,
      now(),
    );
    db.prepare(
      "UPDATE sessions SET total_tokens=total_tokens+?,total_cost_usd=total_cost_usd+?,updated_at=? WHERE id=?",
    ).run(
      result.usage.prompt + result.usage.completion,
      cost,
      now(),
      session.id,
    );
    const totals = db
      .prepare("SELECT total_cost_usd FROM sessions WHERE id=?")
      .get(session.id) as { total_cost_usd: number };
    publish(session.id, "cost_update", {
      turnCostUsd: cost,
      sessionCostUsd: totals.total_cost_usd,
      promptTokens: result.usage.prompt,
      completionTokens: result.usage.completion,
      reasoningTokens: 0,
    });
    if (!toolCalls.length) {
      publish(session.id, "turn_end", {
        turn: 1,
        costUsd: cost,
        tokens: result.usage.prompt + result.usage.completion,
        durationMs: result.latency,
        toolCallCount: callsExecuted,
      });
      return;
    }
    for (const call of toolCalls) {
      if (controller.signal.aborted) break;
      const callId = call.id || randomUUID();
      let args: unknown = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        const err = {
          error: true,
          message: "Tool arguments were malformed JSON.",
          retryable: true,
        };
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify(err),
        });
        continue;
      }
      const started = now();
      const summary = `${call.name} ${JSON.stringify(args).slice(0, 110)}`;
      db.prepare(
        "INSERT INTO tool_calls(id,session_id,turn,tool_name,args_json,status,started_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        callId,
        session.id,
        iteration + 1,
        call.name,
        JSON.stringify(args),
        "running",
        started,
      );
      publish(session.id, "tool_start", {
        callId,
        toolName: call.name,
        args,
        summary,
      });
      let toolResult = await runTool(
        call.name,
        { sessionId: session.id, signal: controller.signal },
        args,
      );
      let serialized = JSON.stringify(toolResult);
      if (serialized.length > toolResultMax)
        serialized = serialized.slice(0, toolResultMax) + "[truncated]";
      const end = now();
      db.prepare(
        "UPDATE tool_calls SET result_json=?,status=?,ended_at=?,duration_ms=? WHERE id=?",
      ).run(serialized, "completed", end, end - started, callId);
      publish(session.id, "tool_end", {
        callId,
        status: "completed",
        result: JSON.parse(serialized),
        durationMs: end - started,
      });
      if (
        call.name.startsWith("git_") ||
        call.name.includes("pull_request") ||
        call.name === "get_check_runs"
      ) {
        publish(session.id, "diff_updated", { tool: call.name });
        publish(session.id, "check_updated", { tool: call.name });
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: serialized,
      });
      callsExecuted++;
    }
    if (controller.signal.aborted) break;
  }
  if (!controller.signal.aborted) {
    publish(session.id, "run_stopped", { reason: "max_iterations" });
    messages.push({
      role: "user",
      content:
        "The tool iteration limit was reached. Summarize the work completed and what remains.",
    });
  }
}

async function chatWithFailover(
  sessionId: string,
  primary: ReturnType<typeof getProvider>,
  primaryModel: string,
  messages: Array<Record<string, unknown>>,
  controller: AbortController,
  reasoning: string,
  mode: RunMode = "agent",
): Promise<{
  result: Awaited<ReturnType<typeof chatStream>>;
  provider: ReturnType<typeof getProvider>;
  model: string;
}> {
  const candidates: Array<{
    provider: ReturnType<typeof getProvider>;
    model: string;
  }> = [{ provider: primary, model: primaryModel }];
  if (config.failoverEnabled) {
    const others = (
      db
        .prepare(
          "SELECT id FROM providers WHERE enabled=1 AND id<>? ORDER BY is_default DESC,created_at",
        )
        .all(primary.id) as Array<{ id: string }>
    )
      .map((row) => {
        try {
          return getProvider(row.id);
        } catch {
          return null;
        }
      })
      .filter((p): p is ReturnType<typeof getProvider> => Boolean(p));
    for (const candidate of others) {
      if (!providerUsable(candidate)) continue;
      const failoverModel = chooseFailoverModel(
        cachedModels(candidate),
        primaryModel,
      );
      if (failoverModel)
        candidates.push({ provider: candidate, model: failoverModel });
    }
  }
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    let emitted = false;
    try {
      const result = await chatStream(
        candidate.provider,
        candidate.model,
        messages,
        mode === "direct" ? [] : openAITools,
        controller.signal,
        reasoning,
        (delta) => {
          emitted = true;
          publish(sessionId, "text_delta", { delta });
        },
      );
      if (index > 0)
        publish(sessionId, "provider_failover", {
          fromProvider: primary.id,
          toProvider: candidate.provider.id,
          model: candidate.model,
          recovered: true,
        });
      return { result, provider: candidate.provider, model: candidate.model };
    } catch (error) {
      lastError = error;
      // Never fail over mid-stream: partial text was already shown to the user.
      if (
        emitted ||
        controller.signal.aborted ||
        index === candidates.length - 1
      )
        throw error;
      publish(sessionId, "provider_failover", {
        fromProvider: candidate.provider.id,
        toProvider: candidates[index + 1]?.provider.id,
        model: candidates[index + 1]?.model,
        recovered: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("All providers failed.");
}

/** Side-by-Side / Battle: one direct (no-tools) completion from a provider/model. */
export async function compareCompletion(
  providerId: string,
  model: string,
  prompt: string,
): Promise<{
  providerId: string;
  providerName: string;
  model: string;
  text: string;
  latencyMs: number;
  usage: { prompt: number; completion: number };
}> {
  const provider = getProvider(providerId);
  if (!provider.enabled)
    throw new Error(`Provider ${provider.name} is disabled.`);
  if (!providerUsable(provider))
    throw new Error(`Configure an API key for ${provider.name} in Settings.`);
  const started = now();
  let text = "";
  const result = await chatStream(
    provider,
    model,
    [{ role: "user", content: prompt }],
    [],
    new AbortController().signal,
    "medium",
    (delta) => {
      text += delta;
    },
  );
  return {
    providerId,
    providerName: provider.name,
    model,
    text: result.text || text,
    latencyMs: now() - started,
    usage: result.usage,
  };
}

function heuristicTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned.split(" ").slice(0, 7).join(" ").slice(0, 64) || "New chat";
}
