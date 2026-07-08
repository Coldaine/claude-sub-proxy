import {
  processChatCompletion,
  completionJson,
  writeStreamingPending,
  manager,
  isAuthorized,
} from "../../../lib/proxy";

export default defineEventHandler(async (event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }

  const body = await readBody(event);
  if (!body || !Array.isArray(body.messages)) {
    setResponseStatus(event, 400);
    return { error: { message: "messages[] required" } };
  }

  // DEBUG: dump the exact request so failures can be replayed verbatim.
  try {
    const dir = process.env.STATE_DIRECTORY;
    if (dir) {
      const { writeFileSync } = await import("node:fs");
      const raw = JSON.stringify(body);
      writeFileSync(`${dir}/last-request.json`, raw);
      // Preserve tool-bearing requests separately — Hermes fires trailing
      // tools=0 aux calls that otherwise overwrite the failing main turn.
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        writeFileSync(`${dir}/last-tool-request.json`, raw);
      }
    }
  } catch {
    /* best effort */
  }

  if (body.stream) {
    writeStreamingPending(event.node.res, processChatCompletion(body));
    return;
  }

  const { boundary, sessionId, model } = await processChatCompletion(body);

  if (boundary.kind === "error") {
    manager.remove(sessionId);
    setResponseStatus(event, 502);
    return { error: { message: boundary.message, type: "upstream_error" } };
  }
  if (boundary.kind === "final") manager.remove(sessionId);

  return completionJson(model, boundary);
});
