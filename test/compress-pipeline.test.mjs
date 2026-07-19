import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { compactMessageText, compressMessages } from '../src/compress/pipeline.mjs';

const DEDUP_BAIT = [
  'export async function writeFile(path, fileText) {',
  '  const directory = path.split("/").slice(0, -1).join("/");',
  '  if (directory) await fs.mkdir(directory, { recursive: true });',
  '  await fs.writeFile(path, fileText, "utf8");',
  '  await audit.log("write_file", path, fileText.length);',
  '  return { ok: true, path, bytes: Buffer.byteLength(fileText) };',
  '}',
  'export const WRITE_FILE_TIMEOUT_MS = 30_000;',
].join('\n');

const OPAQUE_TOOL_TEXT = `${Array.from(
  { length: 8 },
  () => 'line1 // repeated tool payload content that must remain byte exact',
).join('\n')}\n`;

const SIGNED_THINKING_TEXT = `${Array.from(
  { length: 8 },
  () => 'consider branch A before branch B because replay signatures require exact bytes',
).join('\n')}\n`;

describe('compression pipeline regressions', () => {
  it('keeps object-valued tool argument subtrees byte-exact', () => {
    assert.match(compactMessageText(OPAQUE_TOOL_TEXT), /\.\.\. \(repeated 8 times\)/);

    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: DEDUP_BAIT },
          {
            type: 'tool_use',
            name: 'write_file',
            input: {
              path: 'foo.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            arguments: {
              path: 'foo.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            partial_json: {
              path: 'foo.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            input_json: {
              path: 'foo.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: DEDUP_BAIT },
          {
            type: 'tool_use',
            name: 'write_file',
            input: {
              path: 'bar.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            arguments: {
              path: 'bar.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            partial_json: {
              path: 'bar.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
            input_json: {
              path: 'bar.py',
              file_text: OPAQUE_TOOL_TEXT,
            },
          },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    const original = structuredClone(messages);
    const result = compressMessages(messages);

    assert.equal(result.messages[0].content[0].text, DEDUP_BAIT);
    assert.match(result.messages[1].content[0].text, /^\[myelin:/);

    for (let index = 0; index < 2; index += 1) {
      const beforeBlock = original[index].content[1];
      const afterBlock = result.messages[index].content[1];

      assert.equal(JSON.stringify(afterBlock.input), JSON.stringify(beforeBlock.input));
      assert.equal(afterBlock.input.file_text, beforeBlock.input.file_text);
      assert.equal(JSON.stringify(afterBlock.arguments), JSON.stringify(beforeBlock.arguments));
      assert.equal(afterBlock.arguments.file_text, beforeBlock.arguments.file_text);
      assert.equal(JSON.stringify(afterBlock.partial_json), JSON.stringify(beforeBlock.partial_json));
      assert.equal(afterBlock.partial_json.file_text, beforeBlock.partial_json.file_text);
      assert.equal(JSON.stringify(afterBlock.input_json), JSON.stringify(beforeBlock.input_json));
      assert.equal(afterBlock.input_json.file_text, beforeBlock.input_json.file_text);
    }
  });

  it('keeps signed thinking blocks byte-exact when a signature is present', () => {
    assert.match(compactMessageText(SIGNED_THINKING_TEXT), /\.\.\. \(repeated 8 times\)/);

    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: DEDUP_BAIT },
          {
            type: 'thinking',
            thinking: SIGNED_THINKING_TEXT,
            signature: 'sig-v1',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: DEDUP_BAIT },
          {
            type: 'thinking',
            thinking: SIGNED_THINKING_TEXT,
            signature: 'sig-v2',
          },
        ],
      },
      { role: 'user', content: 'continue' },
    ];

    const original = structuredClone(messages);
    const result = compressMessages(messages);

    assert.equal(result.messages[0].content[0].text, DEDUP_BAIT);
    assert.match(result.messages[1].content[0].text, /^\[myelin:/);

    for (let index = 0; index < 2; index += 1) {
      const beforeBlock = original[index].content[1];
      const afterBlock = result.messages[index].content[1];

      assert.equal(afterBlock.thinking, beforeBlock.thinking);
      assert.equal(afterBlock.signature, beforeBlock.signature);
      assert.equal(JSON.stringify(afterBlock), JSON.stringify(beforeBlock));
    }
  });
});

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
  it('with protect_recent=0, all duplicate historical messages become dedup pointers', () => {
    const canonicalText = compactMessageText(DUPLICATE_HISTORY_BLOCK);
    const belowBoundary = compressMessages(makeRepeatedHistory(9)).messages.slice(0, -1);
    const atBoundary = compressMessages(makeRepeatedHistory(10)).messages.slice(0, -1);

    // protect_recent=0: only the first occurrence is canonical; all duplicates become pointers.
    // Previously (protect_recent=2/adaptive), recent turns were shielded from dedup.
    // Now the sidecar is maximally aggressive — agent-level tools (e.g. myelin-compact)
    // decide which context to preserve at a higher level (#2145).
    assert.equal(countCanonicalMessages(belowBoundary, canonicalText), 1);
    assert.equal(countPointers(belowBoundary), 8);
    assert.equal(countCanonicalMessages(atBoundary, canonicalText), 1);
    assert.equal(countPointers(atBoundary), 9);
  });
});
