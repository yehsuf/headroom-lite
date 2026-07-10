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
