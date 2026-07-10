import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { protectTags, restoreTags, withTagProtection } from '../src/compress/tag-protector.mjs';

describe('protectTags', () => {
  it('replaces paired <file>...</file> tags with tokens', () => {
    const text = '<file>hello world</file>';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.ok(!safe.includes('<file>'), 'open tag should be replaced');
    assert.ok(!safe.includes('</file>'), 'close tag should be replaced');
    assert.equal(restoreMap.size, 2);

    const restored = restoreTags(safe, restoreMap);
    assert.equal(restored, text);
  });

  it('protects <thinking>...</thinking> tags', () => {
    const text = '<thinking>\nsome reasoning\n</thinking>';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.ok(!safe.includes('<thinking>'));
    assert.ok(!safe.includes('</thinking>'));

    const restored = restoreTags(safe, restoreMap);
    assert.equal(restored, text);
  });

  it('does NOT protect unpaired <br> (no closing </br>)', () => {
    const text = 'line one<br>line two';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.equal(safe, text, 'unpaired tag must be left as-is');
    assert.equal(restoreMap.size, 0);
  });

  it('protects <function_calls>...</function_calls>', () => {
    const text = '<function_calls>\n{"name":"bash"}\n</function_calls>';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.ok(!safe.includes('<function_calls>'));
    assert.ok(!safe.includes('</function_calls>'));

    const restored = restoreTags(safe, restoreMap);
    assert.equal(restored, text);
  });

  it('handles multiple different paired tags in one text', () => {
    const text = '<result><file>content</file></result>';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.ok(!safe.includes('<result>'));
    assert.ok(!safe.includes('</result>'));
    assert.ok(!safe.includes('<file>'));
    assert.ok(!safe.includes('</file>'));

    const restored = restoreTags(safe, restoreMap);
    assert.equal(restored, text);
  });

  it('leaves text with no tags unchanged', () => {
    const text = 'just plain text\nno tags here';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.equal(safe, text);
    assert.equal(restoreMap.size, 0);
  });

  it('does not protect a tag that appears only as open (no close)', () => {
    const text = '<open>some content without a closing tag';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.equal(safe, text);
    assert.equal(restoreMap.size, 0);
  });

  it('does not protect a tag that appears only as close (no open)', () => {
    const text = 'some content</close> here';
    const { protected: safe, restoreMap } = protectTags(text);

    assert.equal(safe, text);
    assert.equal(restoreMap.size, 0);
  });

  it('tokens are stable opaque strings containing the null-byte prefix', () => {
    const text = '<result>data</result>';
    const { protected: safe, restoreMap } = protectTags(text);

    for (const token of restoreMap.keys()) {
      assert.ok(token.startsWith('\x00HL_TAG_'), `token should start with \\x00HL_TAG_: ${JSON.stringify(token)}`);
      assert.ok(token.endsWith('\x00'), `token should end with \\x00: ${JSON.stringify(token)}`);
    }
  });
});

describe('restoreTags', () => {
  it('is a no-op when restoreMap is empty', () => {
    const text = 'hello world';
    assert.equal(restoreTags(text, new Map()), text);
  });

  it('skips tokens that were removed during transformation', () => {
    const restoreMap = new Map([['\x00HL_TAG_0\x00', '<file>'], ['\x00HL_TAG_1\x00', '</file>']]);
    // Simulate compressor removing a token entirely.
    const compressed = 'some text without any tokens';
    const result = restoreTags(compressed, restoreMap);
    // Should not throw, and tokens that don't exist just stay absent.
    assert.equal(result, compressed);
  });
});

describe('withTagProtection', () => {
  it('round-trips tags through an identity transform', () => {
    const text = '<thinking>deep thought</thinking>';
    const result = withTagProtection(text, (s) => s);
    assert.equal(result, text);
  });

  it('restores tags after a transform that uppercases everything', () => {
    const text = '<file>hello</file>';
    const result = withTagProtection(text, (s) => s.toUpperCase());
    // The token is NUL-byte based so toUpperCase doesn't alter it; tags restored.
    assert.ok(result.includes('<file>'), `expected <file> in: ${result}`);
    assert.ok(result.includes('</file>'), `expected </file> in: ${result}`);
  });

  it('passes plain text through without modification', () => {
    const text = 'no tags here';
    const result = withTagProtection(text, (s) => s + '!');
    assert.equal(result, 'no tags here!');
  });
});
