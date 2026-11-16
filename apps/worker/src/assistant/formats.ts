import type { ModelFormat } from "@ember/protocol/assistant";

// What the formats Ember asks a model in share: Anthropic's Messages and OpenAI's Responses each come two
// ways, through Cloudflare's REST API and through AI Gateway's endpoint for the provider, and xAI's own
// API is Responses too.

/** Whether answers in `format` come as Anthropic's Messages has them, through Cloudflare's REST API or AI Gateway's Anthropic endpoint. */
export const isMessages = (format: ModelFormat) => format === "messages" || format === "anthropic";

/** Whether answers in `format` come as OpenAI's Responses has them, through either, as xAI's own Responses has them too. */
export const isResponses = (format: ModelFormat) => format === "responses" || format === "openai" || format === "xai";

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
