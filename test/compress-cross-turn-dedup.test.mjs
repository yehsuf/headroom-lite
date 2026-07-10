import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dedupBlocks, isPrefixMonotonic } from '../src/compress/cross-turn-dedup.mjs';

const FILE_SPAN = [
  'export async function login(user, password) {',
  '  const account = await loadAccount(user);',
  '  if (!account) throw new Error("missing account");',
  '  const session = await createSession(account.id);',
  '  await audit.log("login", account.id, session.id);',
  '  return { sessionId: session.id, userId: account.id };',
  '}',
  'export const LOGIN_TIMEOUT_MS = 30_000;',
].join('\n');

describe('cross-turn dedup', () => {
  it('folds a repeated multi-line tool span into an earlier-turn pointer', () => {
    const blocks = [
      { turn: 12, text: `cat src/auth/login.mjs\n${FILE_SPAN}\n# eof` },
      { turn: 13, text: `sed -n '1,8p' src/auth/login.mjs\n${FILE_SPAN}\n# done` },
    ];

    const result = dedupBlocks(blocks);

    assert.equal(result.blocks[0].text, blocks[0].text);
    assert.match(result.blocks[1].text, /\[myelin: 8 lines identical to output shown earlier \(turn 12, lines 1-8\)/);
    assert.match(result.blocks[1].text, /starts: "export async function login/);
    assert.equal(result.stats.spansFolded, 1);
    assert.equal(result.stats.linesRemoved, 8);
  });

  it('leaves genuinely different outputs untouched', () => {
    const blocks = [
      { turn: 20, text: `cat src/auth/login.mjs\n${FILE_SPAN}\n# eof` },
      {
        turn: 21,
        text: [
          'git diff -- src/auth/login.mjs',
          '@@ -1,4 +1,4 @@',
          '-export async function login(user, password) {',
          '+export async function login(user, secret) {',
          '+  const startedAt = Date.now();',
        ].join('\n'),
      },
    ];

    const result = dedupBlocks(blocks);

    assert.equal(result.blocks[1].text, blocks[1].text);
    assert.equal(result.stats.spansFolded, 0);
  });

  it('keeps the rewritten prefix stable as later turns are appended', () => {
    const blocks = [
      { turn: 31, text: `cat src/auth/login.mjs\n${FILE_SPAN}\n# eof` },
      { turn: 32, text: `sed -n '1,8p' src/auth/login.mjs\n${FILE_SPAN}\n# done` },
      { turn: 33, text: `python - <<'PY'\n${FILE_SPAN}\nPY` },
    ];

    assert.equal(isPrefixMonotonic(blocks), true);
  });
});
