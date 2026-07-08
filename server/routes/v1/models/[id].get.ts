import { isAuthorized } from "../../../lib/proxy";
import { isListedModel, modelEntry } from "../../../lib/models";

export default defineEventHandler((event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }

  const id = getRouterParam(event, "id") ?? "";
  if (!isListedModel(id)) {
    setResponseStatus(event, 404);
    return { error: { message: `model not found: ${id}` } };
  }

  return modelEntry(id);
});
