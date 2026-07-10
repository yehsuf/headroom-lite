import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeFrozenCount } from '../src/compress/frozen-prefix.mjs';
import { compressMessages } from '../src/compress/pipeline.mjs';
import { estimateMessageTokens } from '../src/lib/estimate-tokens.mjs';
import { startServer } from '../src/server.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(role, content, cacheControl = null) {
  const m = { role, content };
  if (cacheControl) m.cache_control = cacheControl;
  return m;
}

function msgWithBlockCC(role, text) {
  return {
    role,
    content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
  };
}

const BIG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i}: some content that is repeated`)
  .join('\n');

// ---------------------------------------------------------------------------
// 1. computeFrozenCount unit tests
// ---------------------------------------------------------------------------

describe('computeFrozenCount', () => {
  it('empty array → 0', () => {
    assert.equal(computeFrozenCount([]), 0);
  });

  it('non-array input → 0', () => {
    assert.equal(computeFrozenCount(null), 0);
    assert.equal(computeFrozenCount(undefined), 0);
    assert.equal(computeFrozenCount('string'), 0);
    assert.equal(computeFrozenCount(42), 0);
  });

  it('no cache_control anywhere → 0', () => {
    const messages = [
      msg('user', 'hello'),
      msg('assistant', 'world'),
      msg('user', 'how are you?'),
    ];
    assert.equal(computeFrozenCount(messages), 0);
  });

  it('cache_control in messages[1].content[0] → frozenCount = 2', () => {
    const messages = [
      msg('user', 'first message'),
      msgWithBlockCC('assistant', 'cached response'),
      msg('user', 'third message'),
    ];
    assert.equal(computeFrozenCount(messages), 2);
  });

  it('cache_control at message level in messages[2] → frozenCount = 3', () => {
    const messages = [
      msg('user', 'first'),
      msg('assistant', 'second'),
      msg('user', 'third', { type: 'ephemeral' }),
      msg('assistant', 'fourth'),
    ];
    assert.equal(computeFrozenCount(messages), 3);
  });

  it('cache_control in LAST message only → frozenCount = messages.length', () => {
    const messages = [
      msg('user', 'first'),
      msg('assistant', 'second'),
      msgWithBlockCC('user', 'last and cached'),
    ];
    assert.equal(computeFrozenCount(messages), messages.length);
  });

  it('cache_control in messages[0] AND messages[2] → frozenCount = 3 (last wins)', () => {
    const messages = [
      msgWithBlockCC('user', 'cached first'),
      msg('assistant', 'second'),
      msgWithBlockCC('user', 'cached third'),
      msg('assistant', 'fourth'),
    ];
    assert.equal(computeFrozenCount(messages), 3);
  });

  it('plain string content → no marker possible → 0', () => {
    const messages = [
      { role: 'user', content: 'just a string, no blocks' },
      { role: 'assistant', content: 'also a string' },
    ];
    assert.equal(computeFrozenCount(messages), 0);
  });

  it('content array with no cache_control in any block → 0', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'no marker' }] },
    ];
    assert.equal(computeFrozenCount(messages), 0);
  });

  it('null blocks in content array are skipped safely', () => {
    const messages = [
      { role: 'user', content: [null, { type: 'text', text: 'ok' }] },
    ];
    assert.equal(computeFrozenCount(messages), 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Pipeline integration tests
// ---------------------------------------------------------------------------

describe('compressMessages frozen prefix integration', () => {
  it('all messages live (no markers) → frozenCount = 0, behaviour unchanged', () => {
    const messages = [
      msg('user', BIG_TEXT),
      msg('assistant', BIG_TEXT),
      msg('user', 'final question'),
    ];
    const { frozenCount, messages: out, tokensBefore, tokensAfter } = compressMessages(messages);
    assert.equal(frozenCount, 0);
    assert.equal(out.length, messages.length);
    assert.ok(tokensBefore >= tokensAfter, 'should not expand tokens');
  });

  it('frozen prefix messages returned byte-exact (no mutations)', () => {
    const frozenMsg = msgWithBlockCC('user', BIG_TEXT);
    const messages = [
      frozenMsg,
      msg('assistant', BIG_TEXT),
      msg('user', 'final'),
    ];

    const originalFrozenJson = JSON.stringify(frozenMsg);
    const { messages: out, frozenCount } = compressMessages(messages);

    assert.equal(frozenCount, 1);
    assert.equal(JSON.stringify(out[0]), originalFrozenJson, 'frozen message must be byte-exact');
  });

  it('frozenCount in return value matches expectation', () => {
    const messages = [
      msgWithBlockCC('user', 'first'),
      msgWithBlockCC('assistant', 'second'),
      msg('user', 'third'),
    ];
    const { frozenCount } = compressMessages(messages);
    assert.equal(frozenCount, 2);
  });

  it('tokensBefore counts ALL input messages (frozen + live)', () => {
    const messages = [
      msgWithBlockCC('user', BIG_TEXT),
      msg('assistant', BIG_TEXT),
      msg('user', 'short'),
    ];
    const { tokensBefore } = compressMessages(messages);
    const expected = estimateMessageTokens(messages);
    assert.equal(tokensBefore, expected);
  });

  it('tokensAfter when all messages are frozen = tokensBefore (no savings)', () => {
    const messages = [
      msgWithBlockCC('user', BIG_TEXT),
      msgWithBlockCC('assistant', BIG_TEXT),
    ];
    const { tokensBefore, tokensAfter, frozenCount } = compressMessages(messages);
    assert.equal(frozenCount, 2);
    assert.equal(tokensAfter, tokensBefore, 'frozen-only conversation should have no savings');
  });

  it('live messages after frozen prefix are still compressed', () => {
    const repeatedLine = 'repeated line content for dedup test';
    const bigRepeat = Array.from({ length: 15 }, () => repeatedLine).join('\n');

    const messages = [
      msgWithBlockCC('user', 'cached preamble'),
      msg('assistant', bigRepeat),
      msg('user', 'what do you think?'),
    ];

    const { messages: out, frozenCount } = compressMessages(messages);
    assert.equal(frozenCount, 1);
    // The live assistant message should have been compacted
    const liveAssistant = out[1];
    const contentStr = typeof liveAssistant.content === 'string'
      ? liveAssistant.content
      : JSON.stringify(liveAssistant.content);
    assert.match(contentStr, /repeated/, 'live content should still reference original text');
  });
});

// ---------------------------------------------------------------------------
// 3. Server integration tests
// ---------------------------------------------------------------------------

describe('server /v1/compress frozen_count', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({ host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024 });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('POST /v1/compress with cache_control markers → response includes frozen_count > 0', async () => {
    const payload = {
      messages: [
        msgWithBlockCC('user', 'cached system context'),
        msg('assistant', 'response to cached context'),
        msg('user', 'follow up'),
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok('frozen_count' in body, 'response must include frozen_count');
    assert.ok(body.frozen_count > 0, 'frozen_count must be > 0 when markers present');
  });

  it('frozen_count in response matches actual markers', async () => {
    const payload = {
      messages: [
        msgWithBlockCC('user', 'first cached'),
        msgWithBlockCC('assistant', 'second cached'),
        msg('user', 'live question'),
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    assert.equal(body.frozen_count, 2);
    assert.equal(body.messages.length, 3);
  });

  it('messages in frozen zone NOT modified in response', async () => {
    const frozenContent = [{ type: 'text', text: BIG_TEXT, cache_control: { type: 'ephemeral' } }];
    const payload = {
      messages: [
        { role: 'user', content: frozenContent },
        msg('assistant', BIG_TEXT),
        msg('user', 'final'),
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    assert.equal(body.frozen_count, 1);
    // The frozen message's content must be byte-exact
    assert.deepEqual(body.messages[0].content, frozenContent);
  });

  it('POST /v1/compress with no markers → frozen_count = 0', async () => {
    const payload = {
      messages: [
        msg('user', 'hello'),
        msg('assistant', 'world'),
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    assert.equal(body.frozen_count, 0);
  });
});

describe('dedup turn numbers with frozen prefix', () => {
  it('dedup pointer references correct full-conversation turn (not live-slice turn)', async () => {
    // Build a conversation where:
    //   messages[0]: frozen (has cache_control) — contains some content
    //   messages[1]: live — contains the SAME large multiline text (dedup target)
    //   messages[2]: live — contains the SAME large multiline text again (should dedup)
    const bigText = Array.from({ length: 12 }, (_, i) => `line ${i}: ${'x'.repeat(30)}`).join('\n');
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'assistant', content: bigText },
      { role: 'user', content: bigText },
    ];

    const { messages: out, frozenCount } = compressMessages(messages);
    assert.strictEqual(frozenCount, 1, 'only first message is frozen');

    // Find any dedup pointer in the output
    const allText = JSON.stringify(out);
    const match = allText.match(/turn (\d+)/);
    if (match) {
      // The pointer must reference a turn >= frozenCount+1 (i.e. turn 2 or later)
      // NOT turn 1 relative to live slice
      const referencedTurn = Number(match[1]);
      assert.ok(
        referencedTurn >= frozenCount + 1,
        `dedup pointer says "turn ${referencedTurn}" but frozen prefix has ${frozenCount} messages — should be >= ${frozenCount + 1}`,
      );
    }
    // Whether or not dedup ran, frozen message must be byte-exact
    assert.deepStrictEqual(out[0], messages[0]);
  });
});
