const BASE = `http://127.0.0.1:${process.env.PORT ?? 8799}`;

async function postJson(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke-placeholder" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function postResponses(body) {
  const r = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke-placeholder" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function postText(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke-placeholder" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.text();
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { authorization: "Bearer smoke-placeholder" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

const MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";

const health = await getJson("/health");
console.log("[health]", JSON.stringify(health));

const models = await getJson("/v1/models");
console.log("[models] has", MODEL, "=", models.data.some((m) => m.id === MODEL));

const model = await getJson(`/v1/models/${MODEL}`);
console.log("[model]", model.id, model.object);

// 1) plain completion
const a = await postJson("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Reply with exactly: PONG" }] });
console.log("[plain] finish=", a.choices[0].finish_reason, "content=", JSON.stringify(a.choices[0].message.content));

const stream = await postText("/v1/chat/completions", {
  model: MODEL,
  stream: true,
  messages: [{ role: "user", content: "Reply exactly: STREAM_OK" }],
});
console.log("[chat-stream] starts=", JSON.stringify(stream.slice(0, 13)), "done=", stream.includes("data: [DONE]"));

const response = await postResponses({
  model: MODEL,
  input: "Reply exactly: RESPONSE_OK",
  temperature: 0.2,
});
console.log("[responses] status=", response.status, "output_text=", JSON.stringify(response.output_text));

const responseStream = await postText("/v1/responses", {
  model: MODEL,
  stream: true,
  input: "Reply exactly: RESPONSE_STREAM_OK",
});
console.log(
  "[responses-stream] created=",
  responseStream.includes("event: response.created"),
  "delta=",
  responseStream.includes("event: response.output_text.delta"),
  "done=",
  responseStream.includes("data: [DONE]"),
);

// 2) tool round-trip
const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
}];
const msgs = [{ role: "user", content: "Use the get_weather tool to check the weather in Paris, then tell me in one short sentence." }];
const b = await postJson("/v1/chat/completions", { model: MODEL, tools, messages: msgs });
console.log("[tool] finish=", b.choices[0].finish_reason);
const tc = b.choices[0].message.tool_calls?.[0];
console.log("[tool] call=", tc ? `${tc.function.name}(${tc.function.arguments}) id=${tc.id}` : "NONE");

if (tc) {
  // 3) continuation with a tool result
  const c = await postJson("/v1/chat/completions", {
    model: MODEL,
    tools,
    messages: [
      ...msgs,
      { role: "assistant", content: null, tool_calls: b.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: tc.id, content: "18°C, clear skies" },
    ],
  });
  console.log("[resume] finish=", c.choices[0].finish_reason, "content=", JSON.stringify(c.choices[0].message.content));
}
