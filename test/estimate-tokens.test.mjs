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

  it('excludes object-valued tool input/arguments from the estimate', () => {
    const opaqueToolPayload = Array.from(
      { length: 8 },
      () => 'line1 // repeated tool payload content that must remain byte exact',
    ).join('\n') + '\n';

    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'short text' },
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'foo.py', file_text: opaqueToolPayload },
            arguments: { path: 'foo.py', file_text: opaqueToolPayload },
          },
        ],
      },
    ];

    // Only "short text" should count - the object-valued input/arguments
    // must be fully excluded, not just their string-shaped equivalents.
    assert.equal(estimateMessageTokens(messages), estimateTokenCount('short text'));
  });
});
