/**
 * Lossy compression configuration.
 * All settings read from process.env with safe defaults.
 * HEADROOM_LITE_LOSSY=0 by default — opt-in only.
 */

const TRUTHY = new Set(['1', 'true', 'yes']);

export function resolveLossyEnabled(input = process.env.HEADROOM_LITE_LOSSY) {
  return TRUTHY.has((input || '').toLowerCase());
}

export function resolveLossyConfig(env = process.env) {
  return {
    enabled:         resolveLossyEnabled(env.HEADROOM_LITE_LOSSY),
    serviceUrl:      env.HEADROOM_LITE_LOSSY_SERVICE_URL  || 'http://127.0.0.1:8791',
    backend:         env.HEADROOM_LITE_LOSSY_BACKEND       || 'llmlingua2',
    modelName:       env.HEADROOM_LITE_LOSSY_MODEL         || 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank',
    targetRate:      parseFloat(env.HEADROOM_LITE_LOSSY_RATE          || '0.5'),
    timeoutMs:       parseInt(env.HEADROOM_LITE_LOSSY_TIMEOUT_MS      || '1500', 10),
    minChars:        parseInt(env.HEADROOM_LITE_LOSSY_MIN_CHARS       || '1000', 10),
    maxChars:        parseInt(env.HEADROOM_LITE_LOSSY_MAX_CHARS       || '60000', 10),
    maxBatchChars:   parseInt(env.HEADROOM_LITE_LOSSY_MAX_BATCH_CHARS || '120000', 10),
    failClosed:      (env.HEADROOM_LITE_LOSSY_FAIL_CLOSED || '0') === '1',
    compressCode:    (env.HEADROOM_LITE_LOSSY_CODE || '0') === '1',
  };
}
