import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  estimateMessageTokens,
  estimateTokenCount,
} from '../src/lib/estimate-tokens.mjs';

describe('estimate tokens', () => {
  it('counts message text instead of JSON punctuation', () => {
    const estimate = estimateMessageTokens([
      {
        role: 'user',
        content: 'hello',
      },
    ]);

    assert.ok(estimate >= 2 && estimate <= 6);
  });

  it('counts nested text leaves and ignores metadata fields', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'hello there',
          },
        ],
        result: 'tool finished',
        input: '{"should":"skip"}',
        status: 'completed',
        signature: {
          text: 'do not count me',
        },
      },
    ];

    const expected = estimateTokenCount('hello there') + estimateTokenCount('tool finished');
    assert.equal(estimateMessageTokens(messages), expected);
  });
});
