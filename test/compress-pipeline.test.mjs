import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { compactMessageText, compressMessages } from '../src/compress/pipeline.mjs';

const DUPLICATE_HISTORY_BLOCK = [
  'export async function login(user, password) {',
  '  const account = await loadAccount(user);',
  '  if (!account) throw new Error("missing account");',
  '  const session = await createSession(account.id);',
  '  await audit.log("login", account.id, session.id);',
  '  return { sessionId: session.id, userId: account.id };',
  '}',
  'export const LOGIN_TIMEOUT_MS = 30_000;',
].join('\n');

function makeRepeatedHistory(count) {
  return [
    ...Array.from({ length: count }, () => ({
      role: 'assistant',
      content: DUPLICATE_HISTORY_BLOCK,
    })),
    {
      role: 'user',
      content: 'Summarize the repeated login helper.',
    },
  ];
}

function countCanonicalMessages(messages, canonicalText) {
  return messages.filter((message) => message.content === canonicalText).length;
}

function countPointers(messages) {
  return messages.filter((message) => typeof message.content === 'string' && message.content.startsWith('[myelin:')).length;
}

describe('compression pipeline', () => {
  it('skips adaptive sizing at the cap boundary and falls back to protecting five recent items', () => {
    const canonicalText = compactMessageText(DUPLICATE_HISTORY_BLOCK);
    const belowBoundary = compressMessages(makeRepeatedHistory(9)).messages.slice(0, -1);
    const atBoundary = compressMessages(makeRepeatedHistory(10)).messages.slice(0, -1);

    assert.equal(countCanonicalMessages(belowBoundary, canonicalText), 3);
    assert.equal(countPointers(belowBoundary), 6);
    assert.equal(countCanonicalMessages(atBoundary, canonicalText), 6);
    assert.equal(countPointers(atBoundary), 4);
  });
});
