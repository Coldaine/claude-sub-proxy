import type { Boundary } from "./session";
import type { ChatCompletionResult } from "./proxy";
import { sessionIdFromCallId } from "./session";
import {
  contentToText,
  type ChatCompletionRequest,
  type OpenAIMessage,
  type OpenAITool,
} from "./openai-types";

export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  stream?: boolean;
  [k: string]: unknown;
}

interface ResponsesInputItem {
  type?: string;
  role?: OpenAIMessage["role"];
  content?: string | ResponsesContentBlock[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesContentBlock {
  type?: string;
  text?: string;
  output_text?: string;
}

interface ResponsesTool {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

const responseId = () => `resp_${Math.random().toString(36).slice(2)}`;
const outputId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`;

export function responsesToChatCompletion(body: ResponsesRequest): ChatCompletionRequest {
  const messages = responsesInputToMessages(body);
  if (body.instructions) {
    messages.unshift({ role: "system", content: body.instructions });
  }
  return {
    ...body,
    messages,
    tools: responsesToolsToOpenAI(body.tools),
  };
}

export function validateResponsesRequest(body: ResponsesRequest): string | null {
  const input = body.input;
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (item.type !== "function_call" && item.type !== "function_call_output") continue;
    if (!item.call_id || !sessionIdFromCallId(item.call_id)) {
      return `${item.type} requires a valid call_id from this proxy`;
    }
  }
  return null;
}

export function responseJson(
  model: string,
  boundary: Boundary,
  id = responseId(),
  created = Math.floor(Date.now() / 1000),
) {
  const output = responseOutput(boundary);
  return {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
    output_text: outputText(output),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

export function writeResponsesStreaming(
  res: import("node:http").ServerResponse,
  pending: Promise<ChatCompletionResult>,
  onResult: (result: ChatCompletionResult) => void,
): void {
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
  const id = responseId();
  const created = Math.floor(Date.now() / 1000);
  writeEvent(res, "response.created", {
    id,
    object: "response",
    created_at: created,
    status: "in_progress",
    output: [],
  });

  void (async () => {
    try {
      const result = await pending;
      onResult(result);
      if (result.boundary.kind === "error") {
        if (canWrite(res)) writeEvent(res, "response.failed", {
          id,
          object: "response",
          created_at: created,
          status: "failed",
          error: { message: result.boundary.message, type: "upstream_error" },
        });
      } else {
        for (const event of responseStreamEvents(result.model, result.boundary, id, created)) {
          if (canWrite(res)) writeEvent(res, event.name, event.data);
        }
      }
    } catch (err) {
      if (canWrite(res)) writeEvent(res, "response.failed", {
        id,
        object: "response",
        created_at: created,
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" },
      });
    } finally {
      cleanup();
      if (canWrite(res)) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  })();
}

function responsesInputToMessages(body: ResponsesRequest): OpenAIMessage[] {
  const input = body.input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const messages: OpenAIMessage[] = [];
  for (const item of input) {
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output ?? "",
      });
      continue;
    }

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id ?? "",
          type: "function",
          function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
        }],
      });
      continue;
    }

    const role = item.role ?? (item.type === "message" ? "user" : undefined);
    if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
      messages.push({
        role,
        content: responsesContentToText(item.content),
      });
    }
  }
  return messages;
}

function responsesContentToText(content: ResponsesInputItem["content"]): string {
  if (content == null || typeof content === "string") return content ?? "";
  return content
    .map((block) => block.text ?? block.output_text ?? "")
    .join("");
}

function responsesToolsToOpenAI(tools: ResponsesTool[] | undefined): OpenAITool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: OpenAITool[] = [];
  for (const t of tools) {
    if (t.type !== "function") continue;
    const name = t.name ?? t.function?.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: t.description ?? t.function?.description,
        parameters: t.parameters ?? t.function?.parameters,
      },
    });
  }
  return out;
}

function responseOutput(boundary: Boundary) {
  if (boundary.kind === "tool_calls") {
    return boundary.calls.map((call) => ({
      id: outputId("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    }));
  }

  const text = boundary.kind === "final" ? boundary.text : "";
  return [{
    id: outputId("msg"),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }];
}

function responseStreamEvents(model: string, boundary: Boundary, id: string, created: number) {
  const final = responseJson(model, boundary, id, created);
  const events: { name: string; data: unknown }[] = [];

  for (let outputIndex = 0; outputIndex < final.output.length; outputIndex++) {
    const item = final.output[outputIndex];
    if (item.type === "function_call") {
      events.push({
        name: "response.output_item.added",
        data: { type: "response.output_item.added", output_index: outputIndex, item },
      });
      continue;
    }
    if (item.type === "message") {
      events.push({
        name: "response.output_item.added",
        data: { type: "response.output_item.added", output_index: outputIndex, item: { ...item, content: [] } },
      });
      for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
        const content = item.content[contentIndex];
        if (content.type !== "output_text") continue;
        events.push({
          name: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: content.text,
          },
        });
      }
    }
  }

  events.push({ name: "response.completed", data: final });
  return events;
}

function writeEvent(res: import("node:http").ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function canWrite(res: import("node:http").ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

function outputText(output: ReturnType<typeof responseOutput>): string {
  return output
    .flatMap((item) => item.type === "message" ? item.content ?? [] : [])
    .map((block) => contentToText(block.text ?? ""))
    .join("");
}
