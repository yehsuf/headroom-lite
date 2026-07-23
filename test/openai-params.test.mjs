/**
 * Tests for src/normalize/openai-params.mjs (HLITE-B5-PARAM-001)
 *
 * OpenAI GPT-5/o-series reject the legacy `max_tokens` parameter.
 * normalizeOpenAIParams() translates it to `max_completion_tokens` when needed.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeOpenAIParams } from '../src/normalize/openai-params.mjs';

describe('normalizeOpenAIParams', () => {
  it('translates max_tokens → max_completion_tokens when max_completion_tokens is absent', () => {
    const body = { model: 'gpt-5', messages: [], max_tokens: 1024 };
    const result = normalizeOpenAIParams(body);
    assert.equal(result.max_completion_tokens, 1024);
    assert.ok(!('max_tokens' in result), 'max_tokens should be removed');
  });

  it('does not modify body when max_completion_tokens is already present', () => {
    const body = { model: 'gpt-5', messages: [], max_completion_tokens: 512 };
    const result = normalizeOpenAIParams(body);
    assert.equal(result.max_completion_tokens, 512);
    assert.ok(!('max_tokens' in result));
    assert.strictEqual(result, body, 'should return same reference when no change');
  });

  it('leaves both fields when both are present (explicit caller intent)', () => {
    const body = { model: 'gpt-5', messages: [], max_tokens: 1024, max_completion_tokens: 512 };
    const result = normalizeOpenAIParams(body);
    assert.equal(result.max_tokens, 1024, 'max_tokens preserved');
    assert.equal(result.max_completion_tokens, 512, 'max_completion_tokens preserved');
    assert.strictEqual(result, body, 'same reference when no change');
  });

  it('preserves all other body fields', () => {
    const body = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, max_tokens: 256 };
    const result = normalizeOpenAIParams(body);
    assert.equal(result.model, 'gpt-5');
    assert.equal(result.temperature, 0.7);
    assert.deepEqual(result.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(result.max_completion_tokens, 256);
  });

  it('returns body unchanged when max_tokens is absent', () => {
    const body = { model: 'gpt-5', messages: [], temperature: 0.5 };
    const result = normalizeOpenAIParams(body);
    assert.strictEqual(result, body, 'should return same reference');
    assert.ok(!('max_completion_tokens' in result));
  });

  it('handles null body gracefully', () => {
    assert.strictEqual(normalizeOpenAIParams(null), null);
  });

  it('handles non-object body gracefully', () => {
    assert.strictEqual(normalizeOpenAIParams('string'), 'string');
    assert.strictEqual(normalizeOpenAIParams(42), 42);
  });
});
