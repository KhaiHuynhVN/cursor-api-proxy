/**
 * Maps Anthropic/Claude Code model names to Cursor CLI model IDs
 * so clients like Claude Code can send "claude-opus-4-6" and the proxy uses "opus-4.6".
 */

/** Anthropic-style model name (any case) -> Cursor direct API model id */
const ANTHROPIC_TO_CURSOR: Record<string, string> = {
  // Direct API model names (passthrough)
  "claude-opus-4-7-thinking-max": "claude-opus-4-7-thinking-max",
  "claude-opus-4-7-high": "claude-opus-4-7-high",
  "claude-4.6-sonnet-medium-thinking": "claude-4.6-sonnet-medium-thinking",
  // Claude 4.7 (AMP / Claude Code default) — map to Opus thinking-max
  "claude-opus-4-7": "claude-opus-4-7-thinking-max",
  "claude-opus-4.7": "claude-opus-4-7-thinking-max",
  "claude-sonnet-4-7": "claude-4.6-sonnet-medium-thinking",
  "claude-sonnet-4.7": "claude-4.6-sonnet-medium-thinking",
  // Claude 4.6 — map to Sonnet medium thinking (closest match)
  "claude-opus-4-6": "claude-opus-4-7-thinking-max",
  "claude-opus-4.6": "claude-opus-4-7-thinking-max",
  "claude-sonnet-4-6": "claude-4.6-sonnet-medium-thinking",
  "claude-sonnet-4.6": "claude-4.6-sonnet-medium-thinking",
  "claude-sonnet-4-6-thinking": "claude-4.6-sonnet-medium-thinking",
  // Claude 4.5 — fallback to Sonnet
  "claude-opus-4-5": "claude-opus-4-7-thinking-max",
  "claude-opus-4.5": "claude-opus-4-7-thinking-max",
  "claude-sonnet-4-5": "claude-4.6-sonnet-medium-thinking",
  "claude-sonnet-4.5": "claude-4.6-sonnet-medium-thinking",
  // Generic 4.x → Opus thinking-max for opus, Sonnet for sonnet
  "claude-opus-4": "claude-opus-4-7-thinking-max",
  "claude-sonnet-4": "claude-4.6-sonnet-medium-thinking",
  // Haiku (Cursor has no Haiku; map to Sonnet medium for fast responses)
  "claude-haiku-4-5-20251001": "claude-4.6-sonnet-medium-thinking",
  "claude-haiku-4-5": "claude-4.6-sonnet-medium-thinking",
  "claude-haiku-4-6": "claude-4.6-sonnet-medium-thinking",
  "claude-haiku-4": "claude-4.6-sonnet-medium-thinking",
};

/** Cursor IDs we want to expose under Anthropic-style names in GET /v1/models */
const CURSOR_TO_ANTHROPIC_ALIAS: Array<{ cursorId: string; anthropicId: string; name: string }> = [
  { cursorId: "claude-opus-4-7-thinking-max", anthropicId: "claude-opus-4-7", name: "Claude 4.7 Opus (Max)" },
  { cursorId: "claude-opus-4-7-high", anthropicId: "claude-opus-4-7-high", name: "Claude 4.7 Opus (High)" },
  { cursorId: "claude-4.6-sonnet-medium-thinking", anthropicId: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet (Medium)" },
];

/**
 * Resolve a requested model (e.g. from the client) to the Cursor CLI model ID.
 * If the request uses an Anthropic-style name, returns the mapped Cursor ID; otherwise returns the value as-is.
 */
export function resolveToCursorModel(requested: string | undefined): string | undefined {
  if (!requested || !requested.trim()) return undefined;
  const key = requested.trim().toLowerCase();
  return ANTHROPIC_TO_CURSOR[key] ?? requested.trim();
}

/**
 * Return extra model list entries for GET /v1/models so clients like Claude Code
 * see Anthropic-style ids (e.g. claude-opus-4-6) when those Cursor models are available.
 */
export function getAnthropicModelAliases(availableCursorIds: string[]): Array<{ id: string; name: string }> {
  const set = new Set(availableCursorIds);
  return CURSOR_TO_ANTHROPIC_ALIAS
    .filter((a) => set.has(a.cursorId))
    .map((a) => ({ id: a.anthropicId, name: a.name }));
}
