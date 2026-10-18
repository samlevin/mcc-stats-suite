import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keyDistance, rosterKey } from '../src/index';

describe('rosterKey', () => {
  // Every row of the spec 1.2 §7.1 key table.
  for (const [texts, key] of [
    [['Player05', 'PIayer05', 'player05'], 'p1ayer05'],
    [['Player06', 'Player 06'], 'p1ayer06'],
    [['Player10 B C'], 'p1ayer108c'],
    [['Corn Dog'], 'c0md0g'],
  ] as const) {
    for (const text of texts) {
      test(`${text} has key ${key}`, () => {
        assert.equal(rosterKey(text), key);
      });
    }
  }

  test('maps every look-alike group to its representative', () => {
    assert.equal(rosterKey('iIlL1|'), '111111');
    assert.equal(rosterKey('oO0'), '000');
    assert.equal(rosterKey('sS5'), '555');
    assert.equal(rosterKey('bB8'), '888');
    assert.equal(rosterKey('acdz-_#9'), 'acdz-_#9');
  });

  test('applies NFKC before folding', () => {
    // Fullwidth letters and digits, a ligature, and a superscript digit.
    assert.equal(rosterKey('ＰＬＡＹＥＲ０５'), 'p1ayer05');
    assert.equal(rosterKey('ﬁ'), 'f1');
    assert.equal(rosterKey('x²'), 'x2');
    // A precomposed and a decomposed é share one key.
    assert.equal(rosterKey('é'), rosterKey('é'));
  });

  test('replaces rn with m before the look-alike map', () => {
    assert.equal(rosterKey('rn'), 'm');
    assert.equal(rosterKey('RN'), 'm');
    assert.equal(rosterKey('r n'), 'm');
    assert.equal(rosterKey('rnrn'), 'mm');
    assert.equal(rosterKey('rrn'), 'rm');
    // `m` is in no look-alike group, so an `rn` never becomes a digit.
    assert.equal(rosterKey('Barn'), '8am');
  });

  test('removes whitespace of every kind', () => {
    for (const space of [
      ' ',
      '\t',
      '\n',
      '\r',
      '\v',
      '\f',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      '　',
      ' ',
      ' ',
    ]) {
      assert.equal(rosterKey(`Ab${space}c d`), 'a8cd', JSON.stringify(space));
    }
  });

  test('keeps an empty text empty', () => {
    assert.equal(rosterKey(''), '');
    assert.equal(rosterKey('   '), '');
  });
});

describe('keyDistance', () => {
  test('is zero for equal keys and symmetric', () => {
    assert.equal(keyDistance('p1ayer05', 'p1ayer05'), 0);
    for (const [left, right] of [
      ['p1ayer05', 'p1ayer06'],
      ['kitten', 'sitting'],
      ['', 'abc'],
      ['abc', 'cab'],
    ]) {
      assert.equal(keyDistance(left, right), keyDistance(right, left));
    }
    assert.equal(keyDistance('kitten', 'sitting'), 3);
  });

  test('counts a transposition as 2', () => {
    assert.equal(keyDistance('ab', 'ba'), 2);
    assert.equal(keyDistance('p1ayer05', 'p1ayer50'), 2);
  });

  test('handles empty strings', () => {
    assert.equal(keyDistance('', ''), 0);
    assert.equal(keyDistance('', 'abcd'), 4);
    assert.equal(keyDistance('abc', ''), 3);
  });

  test('counts insertions, deletions and substitutions as 1', () => {
    assert.equal(keyDistance('p1ayer', 'p1ayer0'), 1);
    assert.equal(keyDistance('p1ayer0', 'p1ayer'), 1);
    assert.equal(keyDistance('p1ayer0', 'p1ayer9'), 1);
  });

  test('measures code points, not UTF-16 units', () => {
    assert.equal(keyDistance('a😀', 'a'), 1);
    assert.equal(keyDistance('😀', '😁'), 1);
  });
});
