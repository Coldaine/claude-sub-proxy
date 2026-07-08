import {
  SessionManager,
  sessionIdFromCallId,
  type Boundary,
} from "./session";
import {
  contentToText,
  type ChatCompletionRequest,
  type OpenAIMessage,
  type OpenAITool,
} from "./openai-types";
import { CLAUDE_MODELS } from "./models";

export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || undefined;
export const PROXY_API_KEY = process.env.API_KEY || undefined;
export const ALLOW_API_KEY = /^(1|true|yes)$/i.test(process.env.ALLOW_API_KEY ?? "");
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || undefined;

// One process == one SessionManager. Sessions are threaded across the
// stateless HTTP requests by the tool_call ids we hand back.
export const manager = new SessionManager();

export const STATIC_MODELS = CLAUDE_MODELS;

// The whole point: bill the Claude *subscription*, not a metered API key. The
// Agent SDK uses the logged-in Claude credentials only when ANTHROPIC_API_KEY
// is absent — so we strip it from the child env unless explicitly opted in.
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (!ALLOW_API_KEY) delete env.ANTHROPIC_API_KEY;
  return env;
}

export function isAuthorized(authHeader: string | undefined): boolean {
  if (!PROXY_API_KEY) return true;
  return typeof authHeader === "string" && authHeader.replace(/^Bearer\s+/i, "") === PROXY_API_KEY;
}

function splitSystem(messages: OpenAIMessage[]): { system?: string; rest: OpenAIMessage[] } {
  const sys = messages.filter((m) => m.role === "system").map((m) => contentToText(m.content));
  const rest = messages.filter((m) => m.role !== "system");
  return { system: sys.length ? sys.join("\n\n") : undefined, rest };
}

/** Render conversation (no system) as a transcript prompt for a fresh session. */
function renderPrompt(rest: OpenAIMessage[]): string {
  if (rest.length === 1 && rest[0].role === "user") return contentToText(rest[0].content);
  const lines: string[] = [];
  for (const m of rest) {
    if (m.role === "user") {
      lines.push(`User: ${contentToText(m.content)}`);
    } else if (m.role === "assistant") {
      const text = contentToText(m.content);
      if (text) lines.push(`Assistant: ${text}`);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`Assistant called tool ${tc.function.name}(${tc.function.arguments})`);
      }
    } else if (m.role === "tool") {
      lines.push(`Tool result [${m.tool_call_id ?? ""}]: ${contentToText(m.content)}`);
    }
  }
  return lines.join("\n");
}

/** Trailing run of `tool` messages at the end of the conversation. */
function trailingToolMessages(rest: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = rest.length - 1; i >= 0 && rest[i].role === "tool"; i--) out.unshift(rest[i]);
  return out;
}

export async function processChatCompletion(body: ChatCompletionRequest): Promise<{
  boundary: Boundary;
  sessionId: string;
  model: string;
}> {
  const model = body.model || DEFAULT_MODEL || "";
  const { system, rest } = splitSystem(body.messages);
  const tools: OpenAITool[] = body.tools ?? [];

  // Continuation: trailing tool results for a session we still hold.
  const trailing = trailingToolMessages(rest);
  if (trailing.length > 0) {
    const sid = sessionIdFromCallId(trailing[0].tool_call_id ?? "");
    const session = sid ? manager.get(sid) : undefined;
    if (session && session.knowsCall(trailing[0].tool_call_id!)) {
      const results = trailing.map((m) => ({
        tool_call_id: m.tool_call_id!,
        content: contentToText(m.content),
      }));
      const boundary = await session.provideResults(results);
      return { boundary, sessionId: session.id, model };
    }
  }

  // Fresh session (also the fallback when a session was lost, e.g. restart):
  // replay the whole conversation as a transcript.
  const session = manager.create();
  const boundary = await session.start({
    promptText: renderPrompt(rest),
    systemPrompt: system,
    model: model || undefined,
    tools,
    env: childEnv(),
    claudeExecutable: CLAUDE_CLI_PATH,
  });
  return { boundary, sessionId: session.id, model };
}

export type ChatCompletionResult = Awaited<ReturnType<typeof processChatCompletion>>;

const completionId = () => `chatcmpl-${Math.random().toString(36).slice(2)}`;

export function completionJson(model: string, boundary: Boundary) {
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: boundaryToMessage(boundary), finish_reason: finishReason(boundary) }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function boundaryToMessage(boundary: Boundary) {
  if (boundary.kind === "tool_calls") {
    return {
      role: "assistant" as const,
      content: null,
      tool_calls: boundary.calls.map((c) => ({
        id: c.callId,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  return { role: "assistant" as const, content: boundary.kind === "final" ? boundary.text : "" };
}

function finishReason(boundary: Boundary): "tool_calls" | "stop" {
  return boundary.kind === "tool_calls" ? "tool_calls" : "stop";
}

function writeSseHead(res: import("node:http").ServerResponse): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const keepalive = setInterval(() => {
    if (!canWrite(res)) return;
    res.write(": keepalive\n\n");
  }, Number(process.env.STREAM_KEEPALIVE_MS ?? 15000));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepalive);
  };
  res.once("close", cleanup);
  res.once("finish", cleanup);
  return cleanup;
}

/** Write an OpenAI-style SSE stream for a completed boundary, then end. */
export function writeStreaming(res: import("node:http").ServerResponse, model: string, boundary: Boundary): void {
  const cleanup = writeSseHead(res);
  writeChatCompletionChunks(res, model, boundary);
  cleanup();
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Open the SSE stream before Claude finishes, then write the completed boundary. */
export function writeStreamingPending(
  res: import("node:http").ServerResponse,
  pending: Promise<ChatCompletionResult>,
): void {
  const cleanup = writeSseHead(res);
  void (async () => {
    try {
      const { boundary, sessionId, model } = await pending;
      if (boundary.kind === "error") {
        manager.remove(sessionId);
        if (canWrite(res)) writeChatCompletionError(res, model, boundary.message);
      } else {
        if (boundary.kind === "final") manager.remove(sessionId);
        if (canWrite(res)) writeChatCompletionChunks(res, model, boundary);
      }
    } catch (err) {
      if (canWrite(res)) {
        writeChatCompletionError(res, DEFAULT_MODEL ?? "", err instanceof Error ? err.message : String(err));
      }
    } finally {
      cleanup();
      if (canWrite(res)) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  })();
}

function canWrite(res: import("node:http").ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

function writeChatCompletionChunks(
  res: import("node:http").ServerResponse,
  model: string,
  boundary: Boundary,
): void {
  const base = {
    id: completionId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const send = (delta: unknown, finish: string | null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

  if (boundary.kind === "tool_calls") {
    send(
      {
        role: "assistant",
        content: null,
        tool_calls: boundary.calls.map((c, i) => ({
          index: i,
          id: c.callId,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      },
      null,
    );
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: boundary.kind === "final" ? boundary.text : "" }, null);
    send({}, "stop");
  }
}

function writeChatCompletionError(
  res: import("node:http").ServerResponse,
  model: string,
  message: string,
): void {
  const base = {
    id: completionId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "" },
      finish_reason: "stop",
    }],
    error: { message, type: "upstream_error" },
  })}\n\n`);
}
