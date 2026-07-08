import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";

const PORT = 9899;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = "claude-sonnet-4-6";

let server;
let stdout = "";
let stderr = "";

before(async () => {
  server = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(PORT),
      API_KEY: "",
      ALLOW_API_KEY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  stdout = "";
  stderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let lastReadyError = "";
  for (let i = 0; i < 60; i++) {
    if (server.exitCode != null) {
      throw new Error(`server exited before ready: stdout=${stdout} stderr=${stderr}`);
    }
    try {
      const health = await getJson("/health", 1000);
      if (health.status === "ok") return;
    } catch (err) {
      lastReadyError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`server did not become ready: last=${lastReadyError} stdout=${stdout} stderr=${stderr}`);
}, { timeout: 60000 });

after(() => {
  if (server && server.exitCode == null) server.kill();
});

test("health reports subscription-only billing", async () => {
  const health = await getJson("/health");
  assert.equal(health.status, "ok");
  assert.equal(health.billing, "subscription_only");
});

test("models endpoint advertises Claude model ids", async () => {
  const models = await getJson("/v1/models");
  const ids = models.data.map((model) => model.id);
  assert.ok(ids.includes("claude-sonnet-4-6"));
  assert.ok(ids.includes("claude-opus-4-8"));
  assert.ok(ids.includes("claude-haiku-4-5"));
  assert.ok(!ids.includes("gpt-4o"));
});

test("selected model endpoint returns Claude ids as OpenAI model objects", async () => {
  const model = await getJson(`/v1/models/${MODEL}`);
  assert.equal(model.id, MODEL);
  assert.equal(model.object, "model");
  assert.equal(model.owned_by, "anthropic");
});

test("chat completions tolerate unused OpenAI client parameters", async () => {
  const response = await postJson("/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Reply exactly: CHAT_PARAMS_OK" }],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 32,
    stream_options: { include_usage: true },
  }, 120000);

  assert.equal(response.object, "chat.completion");
  assert.match(response.choices[0].message.content, /CHAT_PARAMS_OK/);
});

test("responses endpoint returns an OpenAI Responses object", async () => {
  const response = await postJson("/v1/responses", {
    model: MODEL,
    input: "Reply exactly: RESPONSES_OK",
    temperature: 0.2,
    max_output_tokens: 32,
  }, 120000);

  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.model, MODEL);
  assert.ok(response.output_text.includes("RESPONSES_OK"));
});

test("responses rejects invalid function_call_output call ids", async () => {
  const res = await fetchWithTimeout(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: [{ type: "function_call_output", call_id: "not-a-session-call", output: "unused" }],
    }),
  }, 30000);

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /call_id/i);
});

test("chat streaming opens with an SSE keepalive comment and ends with DONE", async () => {
  const text = await postText("/v1/chat/completions", {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "Reply exactly: CHAT_STREAM_OK" }],
  }, 120000);

  assert.ok(text.startsWith(": connected\n\n"));
  assert.match(text, /CHAT_STREAM_OK/);
  assert.match(text, /data: \[DONE\]/);
});

test("responses endpoint supports OpenAI-style streaming events", async () => {
  const text = await postText("/v1/responses", {
    model: MODEL,
    stream: true,
    input: "Reply exactly: RESPONSES_STREAM_OK",
  }, 120000);

  assert.ok(text.startsWith(": connected\n\n"));
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /RESPONSES_STREAM_OK/);
  assert.match(text, /event: response\.completed/);
  assert.match(text, /data: \[DONE\]/);
});

test("responses function calls can be continued with function_call_output", async () => {
  const first = await postJson("/v1/responses", {
    model: MODEL,
    input: "You must call get_weather for Paris before answering. Do not answer directly.",
    tools: [{
      type: "function",
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    }],
  }, 120000);

  const call = first.output.find((item) => item.type === "function_call");
  assert.ok(call, JSON.stringify(first));
  assert.equal(call.name, "get_weather");
  assert.match(call.arguments, /Paris/i);

  const second = await postJson("/v1/responses", {
    model: MODEL,
    input: [
      ...first.output,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output: "18°C and clear skies",
      },
    ],
    tools: [{
      type: "function",
      name: "get_weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    }],
  }, 120000);

  assert.equal(second.object, "response");
  assert.match(second.output_text, /18|clear|Paris/i);
});

async function getJson(path, timeoutMs = 30000) {
  const res = await fetchWithTimeout(`${BASE}${path}`, { headers: authHeaders() }, timeoutMs);
  if (res.status !== 200) assert.fail(await res.text());
  return res.json();
}

async function postJson(path, body, timeoutMs = 30000) {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (res.status !== 200) assert.fail(await res.text());
  return res.json();
}

async function postText(path, body, timeoutMs = 30000) {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (res.status !== 200) assert.fail(await res.text());
  return res.text();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders() {
  return { authorization: "Bearer cursor-placeholder" };
}
