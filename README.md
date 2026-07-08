# claude-sub-proxy

An OpenAI-compatible HTTP endpoint that fronts the **Claude Agent SDK** and bills
your **Claude subscription** (Max) — with **caller-side function-call passthrough**.

Point any OpenAI-compatible client (it was built for [Hermes
Agent](https://github.com/NousResearch/hermes-agent)'s `provider: custom`, and
also supports Chat Completions / Responses clients) at it, and use Claude as the
model backend without funding a separate pay-per-token `ANTHROPIC_API_KEY`.

## Why this exists

The Claude Agent SDK / `claude -p` runs against your subscription, but it's an
*agent*: it owns the tool-execution loop and only hands back final text. A
tool-using agent like Hermes needs the *raw-model contract* instead — "tell me
which tool to call, I'll run it myself and send you the result" (`tool_calls`).
Existing CLI wrappers only expose `enable_tools: on/off` for Claude's *own*
tools; none do passthrough. This does.

## How it works

Each conversation maps to one live `query()` session. Your tool definitions are
registered as in-process SDK MCP tools whose handlers **don't execute** — they
**suspend** the SDK loop and surface the call to you as an OpenAI `tool_calls`
response (the call id encodes the session). When you POST the tool result back,
the matching handler resolves, the *same* Claude session resumes, and you get
the next tool call or the final answer.

```
client → POST /v1/chat/completions (messages + tools)
       ← finish_reason: "tool_calls"   (Claude suspended mid-loop)
client → POST .../chat/completions (… + tool result)
       ← finish_reason: "stop"         (Claude resumed, final text)
```

## Auth & billing

Subscription billing works because the Agent SDK uses your logged-in Claude
credentials **only when `ANTHROPIC_API_KEY` is absent**. This proxy strips
`ANTHROPIC_API_KEY` from the child environment by default.

Requirements:
- A logged-in Claude CLI (`claude /login`, or `claude setup-token`) — a **Max**
  plan for subscription usage. Credentials live at `~/.claude/.credentials.json`.
- Set `ALLOW_API_KEY=1` only if you *want* metered pay-per-token billing instead.

> Note: driving the subscription from a third-party app is a ToS gray area and
> Anthropic's billing for it has been in flux. Use with that understanding.

## Build & run

Built with [Nitro](https://nitro.build) (bundled to a self-contained
`.output/`) and packaged for Nix with [pnpm2nix](https://github.com/cramt/pnpm2nix).

```bash
pnpm install
pnpm build          # nitro build → .output/
pnpm start          # node .output/server/index.mjs (honours .env)
# or via Nix:
nix run github:cramt/claude-sub-proxy
```

Smoke test (models, Chat Completions, Responses, streaming, and a full tool
round-trip):

```bash
pnpm build && node .output/server/index.mjs &   # in one shell
PORT=8787 node smoke.mjs                          # in another
```

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Bind port |
| `DEFAULT_MODEL` | _(SDK default)_ | Model when a request omits one |
| `API_KEY` | _(none)_ | Optional bearer token clients must present |
| `ALLOW_API_KEY` | `0` | `1` keeps `ANTHROPIC_API_KEY` (metered billing) |
| `CLAUDE_CLI_PATH` | _(bundled)_ | Path to the `claude` executable to drive |
| `STREAM_KEEPALIVE_MS` | `15000` | SSE comment keepalive interval while Claude is running |

## Endpoints

- `POST /v1/chat/completions` — streaming (`stream: true`) and non-streaming, with `tools`/`tool_calls`.
- `POST /v1/responses` — streaming and non-streaming OpenAI Responses compatibility, including function-call output continuation.
- `GET /v1/models` — Claude model list for client discovery.
- `GET /v1/models/:id` — selected model metadata for clients that probe a configured model.
- `GET /health` — status + billing mode.

Streaming endpoints send an initial SSE comment (`: connected`) immediately,
periodic keepalive comments while Claude is running, and a final `data: [DONE]`.

### Models

The proxy advertises and accepts Claude model ids such as:

- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-haiku-4-5`

Unknown model ids are passed through to the Claude SDK unchanged so the proxy
does not invent OpenAI model names or map non-Claude ids onto Claude.

## OpenAI-compatible clients

Use:

- Base URL: `http://127.0.0.1:8787/v1`
- API key: any placeholder value, unless you set `API_KEY` on the proxy
- Model: one of the Claude model ids returned by `GET /v1/models`

If a client has an HTTP compatibility mode for custom OpenAI endpoints, enable it.
That usually reduces assumptions about exact OpenAI-hosted transport behavior.

## Point Hermes at it

```nix
services.hermes-agent.settings.model = {
  default  = "claude-opus-4-8";
  provider = "custom";                       # OpenAI-compatible endpoint
  base_url = "http://127.0.0.1:8787/v1";
  api_key  = "sk-noauth";                     # placeholder; set API_KEY to enforce
};
```

## Limitations

- **Cross-turn context**: a new model interaction replays prior turns as a
  transcript prompt (the SDK can't ingest a native pre-baked assistant/tool
  history). Within a single tool-use cycle, context is the real SDK session.
- **Streaming** emits the completed message/tool-calls as SSE chunks rather than
  token-by-token deltas.
- **Tool schemas**: JSON Schema → Zod conversion is best-effort (descriptions and
  common types preserved; exotic constructs fall back to permissive).
- Requires a logged-in Claude CLI; this is not an API-key proxy by default.
