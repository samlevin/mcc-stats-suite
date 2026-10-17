import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PlayerResolution, RosterEntry } from '@mcc/contracts';
import {
  MAX_READING_LENGTH,
  ROSTER_MATCHER_VERSION,
  errorTypesFor,
  keyDistance,
  resolvePlayers,
  rosterKey,
} from '../src/index';

function roster(...gamertags: string[]): RosterEntry[] {
  return gamertags.map((gamertag) => ({
    gamertagId: `id-${gamertag}`,
    gamertag,
  }));
}

function resolveOne(reading: string, entries: RosterEntry[]): PlayerResolution {
  return resolvePlayers([{ player: reading }], entries)[0];
}

function resolved(
  asRead: string,
  gamertag: string,
  distances: Pick<
    PlayerResolution,
    'keyDistance' | 'runnerUpDistance' | 'textDistance' | 'errorTypes'
  >,
): PlayerResolution {
  return {
    status: 'RESOLVED',
    asRead,
    gamertagId: `id-${gamertag}`,
    gamertag,
    unmatchedReason: null,
    ...distances,
  };
}

function exact(
  gamertag: string,
  runnerUpDistance: number | null,
): PlayerResolution {
  return {
    status: 'EXACT',
    asRead: gamertag,
    gamertagId: `id-${gamertag}`,
    gamertag,
    keyDistance: 0,
    runnerUpDistance,
    textDistance: 0,
    errorTypes: [],
    unmatchedReason: null,
  };
}

function unmatched(
  asRead: string,
  unmatchedReason: PlayerResolution['unmatchedReason'],
  keyDistance: number | null,
  runnerUpDistance: number | null,
): PlayerResolution {
  return {
    status: 'UNMATCHED',
    asRead,
    gamertagId: null,
    gamertag: null,
    keyDistance,
    runnerUpDistance,
    textDistance: null,
    errorTypes: [],
    unmatchedReason,
  };
}

test('the matcher version is roster-matcher-v1', () => {
  assert.equal(ROSTER_MATCHER_VERSION, 'roster-matcher-v1');
});

describe('resolvePlayers per-row rule (spec 6 §7.3)', () => {
  test('an empty roster leaves every row NO_CANDIDATE with null distances', () => {
    assert.deepEqual(
      resolvePlayers([{ player: 'Mantequay' }, { player: '' }], []),
      [
        unmatched('Mantequay', 'NO_CANDIDATE', null, null),
        unmatched('', 'NO_CANDIDATE', null, null),
      ],
    );
  });

  test('a reading over 32 characters is NO_CANDIDATE with null distances', () => {
    const limit = 'Q'.repeat(MAX_READING_LENGTH);
    const entries = roster(limit, 'Mantequay');
    assert.deepEqual(
      resolveOne(`${limit}Q`, entries),
      unmatched(`${limit}Q`, 'NO_CANDIDATE', null, null),
    );
    // Exactly 32 characters is still compared.
    assert.equal(resolveOne(limit, entries).status, 'EXACT');
  });

  test('a reading equal to a gamertag is EXACT with the nearest other key', () => {
    const entries = roster('Mantequay', 'Mantequzz', 'Kayza');
    assert.deepEqual(resolveOne('Mantequay', entries), exact('Mantequay', 2));
    assert.deepEqual(
      resolveOne('Kayza', roster('Kayza')),
      exact('Kayza', null),
    );
  });

  test('a key-equal reading resolves when no other entry is key-equal', () => {
    const entries = roster('Alpha Wolf', 'Kayza');
    assert.deepEqual(
      resolveOne('alpha wolf', entries),
      resolved('alpha wolf', 'Alpha Wolf', {
        keyDistance: 0,
        runnerUpDistance: keyDistance(rosterKey('alpha wolf'), 'kayza'),
        textDistance: 2,
        errorTypes: ['GLYPH_SUBSTITUTION'],
      }),
    );
  });

  test('a near reading at distance 1 resolves within the budget of a 5 to 9 character key', () => {
    const entries = roster('Grizzly', 'Thunderhawk');
    assert.equal(rosterKey('Grizzly'), 'gr1zz1y');
    assert.deepEqual(
      resolveOne('Grizly', entries),
      resolved('Grizly', 'Grizzly', {
        keyDistance: 1,
        runnerUpDistance: keyDistance('gr1z1y', 'thunderhawk'),
        textDistance: 1,
        errorTypes: ['MISSING_CHARACTERS'],
      }),
    );
  });

  test('a near reading at distance 2 resolves within the budget of a 10 character key', () => {
    const entries = roster('Thunderhawk', 'Grizzly');
    assert.deepEqual(
      resolveOne('Thundrhawq', entries),
      resolved('Thundrhawq', 'Thunderhawk', {
        keyDistance: 2,
        runnerUpDistance: keyDistance('thundrhawq', 'gr1zz1y'),
        textDistance: 2,
        errorTypes: ['GLYPH_SUBSTITUTION', 'MISSING_CHARACTERS'],
      }),
    );
  });

  // Each case is a single-entry roster: [gamertag, key length, reading
  // within the budget, reading one edit past it].
  for (const [gamertag, length, within, past, budget] of [
    ['Kayz', 4, 'KAYZ', 'Kayx', 0],
    ['Kayza', 5, 'Kayzq', 'Kxyzq', 1],
    ['Mantequay', 9, 'Mantequax', 'Mantxqxay', 1],
    ['Mantequaya', 10, 'Mxntequayq', 'Xantxqxaya', 2],
  ] as const) {
    test(`a key of ${length} characters allows ${budget} edits and no more`, () => {
      assert.equal(rosterKey(gamertag).length, length);
      const entries = roster(gamertag);
      const near = resolveOne(within, entries);
      assert.equal(near.status, 'RESOLVED');
      assert.equal(near.keyDistance, budget);
      assert.deepEqual(
        resolveOne(past, entries),
        unmatched(past, 'NO_CANDIDATE', budget + 1, null),
      );
    });
  }

  test('a tie past the budget is NO_CANDIDATE, not AMBIGUOUS', () => {
    assert.deepEqual(
      resolveOne('Kayx', roster('Kayz', 'Kayq')),
      unmatched('Kayx', 'NO_CANDIDATE', 1, 1),
    );
  });

  test('a tie within the budget is AMBIGUOUS', () => {
    assert.deepEqual(
      resolveOne('Mantequax', roster('Mantequay', 'Mantequaz')),
      unmatched('Mantequax', 'AMBIGUOUS', 1, 1),
    );
  });

  test('a runner-up less than the margin further away is AMBIGUOUS', () => {
    // d1 = 1 needs d2 >= 3.
    assert.deepEqual(
      resolveOne('Mantequax', roster('Mantequay', 'Mantequzz')),
      unmatched('Mantequax', 'AMBIGUOUS', 1, 2),
    );
    assert.deepEqual(
      resolveOne('Mantequax', roster('Mantequay', 'Mantezzaz')),
      resolved('Mantequax', 'Mantequay', {
        keyDistance: 1,
        runnerUpDistance: 3,
        textDistance: 1,
        errorTypes: ['GLYPH_SUBSTITUTION'],
      }),
    );
  });

  test('never changes the rows it reads', () => {
    const rows = [{ player: 'PIayer05' }, { player: 'Player 06' }];
    const copy = structuredClone(rows);
    resolvePlayers(rows, roster('Player05', 'Player06'));
    assert.deepEqual(rows, copy);
  });
});

describe('resolvePlayers one entry per game (spec 6 §7.4)', () => {
  const entries = roster('Mantequay', 'Kayza');
  const runnerUp = keyDistance('mantequax', 'kayza');

  test('an EXACT row claims its entry from a RESOLVED row', () => {
    assert.deepEqual(
      resolvePlayers(
        [{ player: 'Mantequay' }, { player: 'Mantequax' }],
        entries,
      ),
      [
        exact('Mantequay', keyDistance('mantequay', 'kayza')),
        unmatched('Mantequax', 'ENTRY_CLAIMED', 1, runnerUp),
      ],
    );
  });

  test('two rows RESOLVED to one entry both become ENTRY_CLAIMED', () => {
    assert.deepEqual(
      resolvePlayers(
        [{ player: 'Mantequax' }, { player: 'Mantequaq' }, { player: 'Kayza' }],
        entries,
      ),
      [
        unmatched('Mantequax', 'ENTRY_CLAIMED', 1, runnerUp),
        unmatched(
          'Mantequaq',
          'ENTRY_CLAIMED',
          1,
          keyDistance('mantequaq', 'kayza'),
        ),
        exact('Kayza', keyDistance('kayza', 'mantequay')),
      ],
    );
  });

  test('two EXACT rows of one name both stay EXACT', () => {
    const results = resolvePlayers(
      [{ player: 'Kayza' }, { player: 'Kayza' }],
      entries,
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['EXACT', 'EXACT'],
    );
  });

  test('results do not depend on row order', () => {
    const rows = [
      { player: 'Mantequax' },
      { player: 'Kayzq' },
      { player: 'Mantequay' },
      { player: 'Unknown Player' },
      { player: 'Mantequaq' },
      { player: 'KAYZA' },
    ];
    const forward = resolvePlayers(rows, entries);
    const permutations = [
      [5, 4, 3, 2, 1, 0],
      [2, 0, 4, 1, 5, 3],
      [3, 5, 1, 0, 2, 4],
    ];
    for (const order of permutations) {
      const reordered = resolvePlayers(
        order.map((index) => rows[index]),
        [...entries].reverse(),
      );
      assert.deepEqual(
        reordered,
        order.map((index) => forward[index]),
      );
    }
    // Kayzq and KAYZA both resolve to Kayza, so neither keeps it.
    assert.deepEqual(
      forward.map((result) => [result.status, result.unmatchedReason]),
      [
        ['UNMATCHED', 'ENTRY_CLAIMED'],
        ['UNMATCHED', 'ENTRY_CLAIMED'],
        ['EXACT', null],
        ['UNMATCHED', 'NO_CANDIDATE'],
        ['UNMATCHED', 'ENTRY_CLAIMED'],
        ['UNMATCHED', 'ENTRY_CLAIMED'],
      ],
    );
  });
});

describe('errorTypesFor (spec 6 §7.5)', () => {
  for (const [asRead, gamertag, types] of [
    ['Kayzb', 'Kayza', ['GLYPH_SUBSTITUTION']],
    ['kayza', 'Kayza', ['GLYPH_SUBSTITUTION']],
    ['PIayer05', 'Player05', ['GLYPH_SUBSTITUTION']],
    ['Player 06', 'Player06', ['EXTRA_CHARACTERS']],
    ['Grizly', 'Grizzly', ['MISSING_CHARACTERS']],
    ['Thundrhawq', 'Thunderhawk', ['GLYPH_SUBSTITUTION', 'MISSING_CHARACTERS']],
    [
      'xAbcd',
      'abcdy',
      ['EXTRA_CHARACTERS', 'GLYPH_SUBSTITUTION', 'MISSING_CHARACTERS'],
    ],
    // Substitutions are preferred, so a swap is two substitutions.
    ['ab', 'ba', ['GLYPH_SUBSTITUTION']],
    ['', 'ab', ['MISSING_CHARACTERS']],
    ['ab', '', ['EXTRA_CHARACTERS']],
    ['Kayza', 'Kayza', []],
  ] as const) {
    test(`${JSON.stringify(asRead)} to ${JSON.stringify(gamertag)} is ${types.join(', ') || 'none'}`, () => {
      assert.deepEqual(errorTypesFor(asRead, gamertag), types);
    });
  }
});

describe('the #91 fixtures (spec 6 §9.1)', () => {
  // The 14 placeholder gamertags of halo3-two-team-capture-1 and -2.
  const placeholders = roster(
    'Player01 A',
    'Player02',
    'Player03',
    'Player04',
    'Player05',
    'Player06',
    'Player07',
    'Player08',
    'Player09',
    'Player10 B C',
    'Player11',
    'Player12',
    'Player13',
    'Player14',
  );
  // The 16 player names the parser reads from the two captures.
  const capture1 = [
    'Player01 A',
    'Player02',
    'Player03',
    'Player04',
    'Player05',
    'Player06',
    'Player07',
    'Player08',
  ];
  const capture2 = [
    'Player09',
    'PIayer05',
    'Player10 B C',
    'Player 06',
    'Player11',
    'Player12',
    'Player13',
    'Player14',
  ];
  const rows = (names: string[]) => names.map((player) => ({ player }));

  test('the 14 placeholders have 14 distinct keys', () => {
    assert.equal(
      new Set(placeholders.map((entry) => rosterKey(entry.gamertag))).size,
      14,
    );
  });

  test('capture 1 reads 8 EXACT rows', () => {
    const results = resolvePlayers(rows(capture1), placeholders);
    assert.equal(results.length, 8);
    results.forEach((result, index) => {
      assert.equal(result.status, 'EXACT');
      assert.equal(result.gamertag, capture1[index]);
      assert.equal(result.keyDistance, 0);
      assert.equal(result.textDistance, 0);
    });
  });

  test('capture 2 reads 6 EXACT rows and resolves the two misreads', () => {
    const results = resolvePlayers(rows(capture2), placeholders);
    assert.deepEqual(
      results.map((result) => result.status),
      [
        'EXACT',
        'RESOLVED',
        'EXACT',
        'RESOLVED',
        'EXACT',
        'EXACT',
        'EXACT',
        'EXACT',
      ],
    );
    assert.deepEqual(
      results[1],
      resolved('PIayer05', 'Player05', {
        keyDistance: 0,
        runnerUpDistance: 1,
        textDistance: 1,
        errorTypes: ['GLYPH_SUBSTITUTION'],
      }),
    );
    assert.deepEqual(
      results[3],
      resolved('Player 06', 'Player06', {
        keyDistance: 0,
        runnerUpDistance: 1,
        textDistance: 1,
        errorTypes: ['EXTRA_CHARACTERS'],
      }),
    );
  });

  test('PIayer05 is AMBIGUOUS once Player05 leaves the roster', () => {
    const without = placeholders.filter(
      (entry) => entry.gamertag !== 'Player05',
    );
    assert.deepEqual(
      resolvePlayers(rows(capture2), without)[1],
      unmatched('PIayer05', 'AMBIGUOUS', 1, 1),
    );
  });
});
