export const CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

export function listedModels(): string[] {
  return CLAUDE_MODELS;
}

export function modelEntry(id: string) {
  return { id, object: "model", created: 0, owned_by: "anthropic" };
}

export function isListedModel(id: string): boolean {
  return CLAUDE_MODELS.includes(id);
}
