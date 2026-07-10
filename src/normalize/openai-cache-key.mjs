import { createHash } from 'node:crypto';

/**
 * Derive a stable prompt_cache_key for OpenAI-format requests.
 *
 * Key is SHA-256(model + sorted_tool_names + system_text).
 * Only injected when:
 *   1. Request doesn't already have a prompt_cache_key
 *   2. Request has model field (required for OpenAI)
 *   3. HEADROOM_LITE_OPENAI_CACHE_KEY=true env var is set
 *
 * Never injected for Anthropic-format requests (they use cache_control instead).
 * Never modifies auth headers or message content.
 *
 * @param {object} body - Parsed OpenAI request body
 * @returns {object} body with prompt_cache_key added (or original if not applicable)
 */
export function injectOpenAICacheKey(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.prompt_cache_key != null) return body; // already has one, never override
  if (typeof body.model !== 'string') return body; // no model, can't derive stable key

  const systemText = extractSystemText(body.messages ?? []);
  const toolNames = extractToolNames(body.tools ?? []);

  const key = deriveKey(body.model, systemText, toolNames);
  return { ...body, prompt_cache_key: key };
}

/**
 * Resolve whether OpenAI cache key injection is enabled.
 *
 * @param {string} [input] - env value override (defaults to HEADROOM_LITE_OPENAI_CACHE_KEY)
 * @returns {boolean}
 */
export function resolveOpenAICacheKey(input = process.env.HEADROOM_LITE_OPENAI_CACHE_KEY) {
  return input === 'true' || input === '1';
}

function deriveKey(model, systemText, toolNames) {
  const canonical = JSON.stringify({ model, system: systemText, tools: toolNames.sort() });
  return 'hl-' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function extractSystemText(messages) {
  // OpenAI: system is messages[0].role === 'system' with content as string or array
  const sys = messages.find(m => m?.role === 'system');
  if (!sys) return '';
  return typeof sys.content === 'string' ? sys.content :
    (Array.isArray(sys.content) ? sys.content.filter(b => b?.type === 'text').map(b => b.text).join('') : '');
}

function extractToolNames(tools) {
  return tools.map(t => t?.function?.name ?? t?.name ?? '').filter(Boolean);
}
