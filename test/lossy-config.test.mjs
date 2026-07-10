import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLossyConfig, resolveLossyEnabled } from '../src/lossy/config.mjs';

describe('resolveLossyEnabled', () => {
  it('accepts "1"', () => { assert.equal(resolveLossyEnabled('1'), true); });
  it('accepts "true"', () => { assert.equal(resolveLossyEnabled('true'), true); });
  it('accepts "yes"', () => { assert.equal(resolveLossyEnabled('yes'), true); });
  it('accepts "TRUE" case-insensitively', () => { assert.equal(resolveLossyEnabled('TRUE'), true); });
  it('rejects "0"', () => { assert.equal(resolveLossyEnabled('0'), false); });
  it('rejects empty string', () => { assert.equal(resolveLossyEnabled(''), false); });
  it('rejects undefined', () => { assert.equal(resolveLossyEnabled(undefined), false); });
  it('rejects arbitrary strings', () => { assert.equal(resolveLossyEnabled('maybe'), false); });
});

describe('resolveLossyConfig', () => {
  it('returns defaults with empty env', () => {
    const cfg = resolveLossyConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.serviceUrl, 'http://127.0.0.1:8791');
    assert.equal(cfg.backend, 'llmlingua2');
    assert.equal(cfg.modelName, 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank');
    assert.equal(cfg.targetRate, 0.5);
    assert.equal(cfg.timeoutMs, 1500);
    assert.equal(cfg.minChars, 1000);
    assert.equal(cfg.maxChars, 60000);
    assert.equal(cfg.maxBatchChars, 120000);
    assert.equal(cfg.failClosed, false);
    assert.equal(cfg.compressCode, false);
  });

  it('reads all env vars correctly', () => {
    const cfg = resolveLossyConfig({
      HEADROOM_LITE_LOSSY: '1',
      HEADROOM_LITE_LOSSY_SERVICE_URL: 'http://example:9000',
      HEADROOM_LITE_LOSSY_BACKEND: 'custom',
      HEADROOM_LITE_LOSSY_MODEL: 'foo/bar',
      HEADROOM_LITE_LOSSY_RATE: '0.7',
      HEADROOM_LITE_LOSSY_TIMEOUT_MS: '3000',
      HEADROOM_LITE_LOSSY_MIN_CHARS: '500',
      HEADROOM_LITE_LOSSY_MAX_CHARS: '10000',
      HEADROOM_LITE_LOSSY_MAX_BATCH_CHARS: '50000',
      HEADROOM_LITE_LOSSY_FAIL_CLOSED: '1',
      HEADROOM_LITE_LOSSY_CODE: '1',
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.serviceUrl, 'http://example:9000');
    assert.equal(cfg.backend, 'custom');
    assert.equal(cfg.modelName, 'foo/bar');
    assert.equal(cfg.targetRate, 0.7);
    assert.equal(cfg.timeoutMs, 3000);
    assert.equal(cfg.minChars, 500);
    assert.equal(cfg.maxChars, 10000);
    assert.equal(cfg.maxBatchChars, 50000);
    assert.equal(cfg.failClosed, true);
    assert.equal(cfg.compressCode, true);
  });

  it('produces NaN when HEADROOM_LITE_LOSSY_RATE is not parseable', () => {
    const cfg = resolveLossyConfig({ HEADROOM_LITE_LOSSY_RATE: 'not-a-number' });
    assert.ok(Number.isNaN(cfg.targetRate));
  });

  it('failClosed remains false for any value other than "1"', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const cfg = resolveLossyConfig({ HEADROOM_LITE_LOSSY_FAIL_CLOSED: value });
      assert.equal(cfg.failClosed, false, `value=${JSON.stringify(value)}`);
    }
  });
});
