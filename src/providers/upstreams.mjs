/**
 * Multi-provider upstream resolution.
 *
 * Resolves a per-request upstream URL from environment variables, with a
 * per-provider precedence over the legacy single-upstream fallback.
 *
 * Env vars (all optional):
 *   HEADROOM_LITE_UPSTREAM_ANTHROPIC      — upstream for Anthropic paths
 *   HEADROOM_LITE_UPSTREAM_OPENAI         — upstream for OpenAI paths
 *   HEADROOM_LITE_UPSTREAM_GITHUB_MODELS  — upstream for GitHub Models paths
 *   HEADROOM_LITE_UPSTREAM               — legacy single-upstream fallback
 *
 * Precedence: provider-specific > legacy > null
 *
 * Design rules:
 *   - Never read or classify auth headers.
 *   - URL validation happens at resolution time (startup), not per-request.
 *   - Unknown provider falls through to legacy only.
 */

/** @typedef {import('./detect.mjs').Provider} Provider */

const PROVIDER_ENV_KEYS = {
  anthropic: 'HEADROOM_LITE_UPSTREAM_ANTHROPIC',
  openai: 'HEADROOM_LITE_UPSTREAM_OPENAI',
  'github-models': 'HEADROOM_LITE_UPSTREAM_GITHUB_MODELS',
};

/**
 * Validate and normalize a raw upstream URL string.
 * Throws with the env-var name in the message if the URL is invalid.
 *
 * @param {string} raw
 * @param {string} envKey — used in the error message
 * @returns {string} normalized URL (no trailing slash)
 */
function parseUpstreamUrl(raw, envKey) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envKey} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${envKey} must use http: or https: — got: ${url.protocol}`);
  }
  if (url.search) {
    throw new Error(`${envKey} must not include a query string — got: ${raw}`);
  }
  return url.href.replace(/\/$/, '');
}

/**
 * @param {string|undefined|null} value
 * @param {string} envKey
 * @returns {string|null}
 */
function resolveOne(value, envKey) {
  if (!value) return null;
  return parseUpstreamUrl(value, envKey);
}

/**
 * Resolve the full upstreams map from the environment.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ legacy: string|null, anthropic: string|null, openai: string|null, 'github-models': string|null }}
 */
export function resolveUpstreams(env = process.env) {
  return {
    legacy: resolveOne(env['HEADROOM_LITE_UPSTREAM'], 'HEADROOM_LITE_UPSTREAM'),
    anthropic: resolveOne(env['HEADROOM_LITE_UPSTREAM_ANTHROPIC'], 'HEADROOM_LITE_UPSTREAM_ANTHROPIC'),
    openai: resolveOne(env['HEADROOM_LITE_UPSTREAM_OPENAI'], 'HEADROOM_LITE_UPSTREAM_OPENAI'),
    'github-models': resolveOne(env['HEADROOM_LITE_UPSTREAM_GITHUB_MODELS'], 'HEADROOM_LITE_UPSTREAM_GITHUB_MODELS'),
  };
}

/**
 * Select the upstream URL for a given provider.
 * Provider-specific upstream takes precedence over legacy.
 * Unknown provider falls through to legacy only.
 *
 * @param {{ legacy: string|null, [key: string]: string|null }} upstreams
 * @param {Provider} provider
 * @returns {string|null}
 */
export function selectUpstream(upstreams, provider) {
  const specific = upstreams[provider] ?? null;
  return specific ?? upstreams.legacy ?? null;
}
