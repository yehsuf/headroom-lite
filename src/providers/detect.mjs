/**
 * Provider and format detection from request pathname.
 *
 * Design rules (non-negotiable):
 *   - Path-only detection. Headers are NEVER inspected (auth-opaque invariant).
 *   - One source of truth: format is always derived from provider, never computed separately.
 *   - Pure function: no I/O, no throws, no global state.
 *
 * Provider routing table:
 *   /v1/messages*, /v1/complete*            -> anthropic / anthropic
 *   /openai/deployments/{id}/chat/completions -> github-models / openai  (Azure-style GitHub Models)
 *   /chat/completions (root, no /v1/)     -> github-models / openai  (https://models.github.ai)
 *   /v1/chat/completions, /v1/responses*  -> openai / openai
 *   everything else                       -> unknown / unknown
 */

/** @typedef {'anthropic'|'openai'|'github-models'|'unknown'} Provider */
/** @typedef {'anthropic'|'openai'|'unknown'} Format */
/** @typedef {{ provider: Provider, format: Format }} ProviderInfo */

/** @type {ReadonlyArray<Provider>} */
export const PROVIDERS = Object.freeze(['anthropic', 'openai', 'github-models', 'unknown']);
/** @type {ReadonlyArray<Format>} */
export const FORMATS = Object.freeze(['anthropic', 'openai', 'unknown']);

const AZURE_DEPLOYMENTS_RE = /^\/openai\/deployments\/[^/]+\/chat\/completions(?:\/|$)/;

/**
 * Detect the provider and API format from a URL pathname.
 *
 * @param {string} pathname - URL pathname (e.g. '/v1/messages'). Query strings
 *   must be stripped by the caller before passing here; this function strips
 *   defensively but callers should pass clean pathnames.
 * @returns {ProviderInfo}
 */
export function detectProvider(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return { provider: 'unknown', format: 'unknown' };
  }

  // Strip query string defensively — callers should pass URL.pathname but we guard anyway.
  const p = pathname.includes('?') ? pathname.slice(0, pathname.indexOf('?')) : pathname;

  // Anthropic
  if (p.startsWith('/v1/messages') || p.startsWith('/v1/complete')) {
    return { provider: 'anthropic', format: 'anthropic' };
  }

  // GitHub Models — Azure-style: /openai/deployments/{deployment}/chat/completions
  // Must be checked BEFORE the generic /chat/completions rule.
  if (AZURE_DEPLOYMENTS_RE.test(p)) {
    return { provider: 'github-models', format: 'openai' };
  }

  // GitHub Models — root path: https://models.github.ai/inference → /chat/completions
  // Distinguished from OpenAI (/v1/chat/completions) by the absence of a /v1/ prefix.
  if (p === '/chat/completions' || p.startsWith('/chat/completions/')) {
    return { provider: 'github-models', format: 'openai' };
  }

  // OpenAI
  if (p.includes('/chat/completions') || p.includes('/v1/responses')) {
    return { provider: 'openai', format: 'openai' };
  }

  return { provider: 'unknown', format: 'unknown' };
}

/**
 * Convenience wrapper — returns only the format string.
 * Kept for call-site backward compatibility with the old private detectFormat() in proxy.mjs.
 *
 * @param {string} pathname
 * @returns {Format}
 */
export function detectFormat(pathname) {
  return detectProvider(pathname).format;
}
