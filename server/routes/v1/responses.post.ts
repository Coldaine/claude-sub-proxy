import {
  isAuthorized,
  manager,
  processChatCompletion,
} from "../../lib/proxy";
import {
  responseJson,
  responsesToChatCompletion,
  validateResponsesRequest,
  writeResponsesStreaming,
} from "../../lib/responses";

export default defineEventHandler(async (event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }

  const body = await readBody(event);
  const validationError = validateResponsesRequest(body ?? {});
  if (validationError) {
    setResponseStatus(event, 400);
    return { error: { message: validationError } };
  }

  const chatBody = responsesToChatCompletion(body ?? {});
  if (!Array.isArray(chatBody.messages) || chatBody.messages.length === 0) {
    setResponseStatus(event, 400);
    return { error: { message: "input required" } };
  }

  if (body?.stream) {
    writeResponsesStreaming(event.node.res, processChatCompletion(chatBody), ({ boundary, sessionId }) => {
      if (boundary.kind === "error" || boundary.kind === "final") manager.remove(sessionId);
    });
    return;
  }

  const { boundary, sessionId, model } = await processChatCompletion(chatBody);

  if (boundary.kind === "error") {
    manager.remove(sessionId);
    setResponseStatus(event, 502);
    return { error: { message: boundary.message, type: "upstream_error" } };
  }
  if (boundary.kind === "final") manager.remove(sessionId);

  return responseJson(model, boundary);
});
