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
  it('folds a repeated multi-line tool span into a 1-based earlier-turn pointer', () => {
    const blocks = [
      { turn: 12, text: `cat src/auth/login.mjs\n${FILE_SPAN}\n# eof` },
      { turn: 13, text: `sed -n '1,8p' src/auth/login.mjs\n${FILE_SPAN}\n# done` },
    ];

    const result = dedupBlocks(blocks);

    assert.equal(result.blocks[0].text, blocks[0].text);
    assert.match(result.blocks[1].text, /\[myelin: 8 lines identical to output shown earlier \(turn 12, lines 2-9\)/);
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

  it('pointer line numbers reflect rendered position when referenced block has its own prior fold', () => {
    // Block A (turn 1): 10 unique lines — no folds, used as the initial anchor.
    const UNIQUE_HEADER = [
      'function initPipeline(config) {',
      '  const registry = new Map();',
      '  config.plugins.forEach((p) => registry.set(p.name, p));',
      '  const ctx = { registry, config };',
      '  validatePlugins(ctx);',
      '  return ctx;',
      '}',
    ].join('\n');

    // TRAILER is the unique content after the fold in block B.
    // It must be long enough to meet minChars (>= 120 chars) on its own.
    const TRAILER = [
      'export function applyPipeline(ctx, input) {',
      '  for (const [, plugin] of ctx.registry) {',
      '    input = plugin.transform(input, ctx.config);',
      '  }',
      '  return input;',
      '}',
      'export const PIPELINE_VERSION = 2;',
    ].join('\n');

    // Block B (turn 2): begins with FILE_SPAN (foldable against A → pointer at displayed line 0),
    // then TRAILER (7 unique lines at displayed lines 1–7 after the fold).
    const blockBText = `${FILE_SPAN}\n${TRAILER}`;
    // Block B's rendered output will be:
    //   line 0 (displayed): [myelin pointer to turn 1 lines 2-9]   ← fold of FILE_SPAN
    //   lines 1–7 (displayed): TRAILER lines

    // Block C (turn 3): repeats TRAILER — should reference B at its *displayed* position 1,
    // not at the raw verbatim index (8, because FILE_SPAN occupies slots 0–7 as nulls).
    const blocks = [
      { turn: 1, text: `${UNIQUE_HEADER}\n${FILE_SPAN}` },
      { turn: 2, text: blockBText },
      { turn: 3, text: TRAILER },
    ];

    const result = dedupBlocks(blocks, { minLines: 7, minChars: 120 });

    // Block B: FILE_SPAN should be folded (matched against block A)
    assert.match(result.blocks[1].text, /\[myelin:.*identical.*turn 1/);

    // Block C: TRAILER should be folded, referencing block B.
    // The pointer must reference turn 2. After the fold in block B, TRAILER starts
    // at displayed line 1 (0-based), so lines 2–8 in 1-based notation.
    assert.match(result.blocks[2].text, /\[myelin: 7 lines identical to output shown earlier \(turn 2, lines 2-8\)/,
      'pointer should reference the rendered position in block B (lines 2-8), not the raw verbatim index (9-15)');
  });
});
