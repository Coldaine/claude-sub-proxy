import { isAuthorized } from "../../lib/proxy";
import { listedModels, modelEntry } from "../../lib/models";

export default defineEventHandler((event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }
  return {
    object: "list",
    data: listedModels().map(modelEntry),
  };
});
