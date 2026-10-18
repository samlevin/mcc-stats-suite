import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { RosterChange, RosterChangeAction } from '@mcc/contracts';
import {
  EMPTY_ROSTER,
  RosterIntegrityError,
  activeEntries,
  checkChange,
  foldRoster,
  rosterSha256,
  type AcceptedRosterChange,
  type Roster,
  type RosterChangeRequest,
  type RosterRefusal,
} from '../src/index';

const REQUEST_ID = '6f1c1a9e-3b0d-4c55-9f43-0e8a2b7d5c11';

function change(
  rosterVersion: number,
  action: RosterChangeAction,
  gamertagId: string,
  gamertag: string,
): RosterChange {
  return {
    schemaVersion: 'roster-change/v1',
    namespace: 'stable',
    rosterVersion,
    action,
    gamertagId,
    gamertag,
    reason: null,
    actorArn: 'arn:aws:sts::000000000000:assumed-role/test/operator',
    clientRequestId: REQUEST_ID,
    changedAt: '2026-10-17T00:00:00.000Z',
    rosterSha256: '',
  };
}

/** Folds an add of each gamertag, with IDs `g1`, `g2`, ... in order. */
function rosterOf(...gamertags: string[]): Roster {
  return foldRoster(
    gamertags.map((gamertag, index) =>
      change(index + 1, 'ADD', `g${index + 1}`, gamertag),
    ),
  );
}

function hashOf(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

describe('foldRoster (spec 1.2 §5.1)', () => {
  test('an empty log is version 0 with no entries', () => {
    assert.deepEqual(foldRoster([]), { rosterVersion: 0, entries: [] });
    assert.deepEqual(foldRoster([]), EMPTY_ROSTER);
  });

  test('applies add, deactivate and reactivate in order', () => {
    const roster = foldRoster([
      change(1, 'ADD', 'g1', 'Kayza'),
      change(2, 'ADD', 'g2', 'Mantequay'),
      change(3, 'DEACTIVATE', 'g1', 'Kayza'),
      change(4, 'DEACTIVATE', 'g2', 'Mantequay'),
      change(5, 'REACTIVATE', 'g1', 'Kayza'),
    ]);
    assert.deepEqual(roster, {
      rosterVersion: 5,
      entries: [
        {
          gamertagId: 'g1',
          gamertag: 'Kayza',
          status: 'ACTIVE',
          addedVersion: 1,
          lastChangedVersion: 5,
        },
        {
          gamertagId: 'g2',
          gamertag: 'Mantequay',
          status: 'INACTIVE',
          addedVersion: 2,
          lastChangedVersion: 4,
        },
      ],
    });
  });

  test('folds later changes onto a cached roster without changing it', () => {
    const cached = rosterOf('Kayza', 'Mantequay');
    const snapshot = structuredClone(cached);
    const next = foldRoster(
      [
        change(3, 'DEACTIVATE', 'g1', 'Kayza'),
        change(4, 'ADD', 'g4', 'Grizzly'),
      ],
      cached,
    );
    assert.deepEqual(cached, snapshot);
    assert.deepEqual(
      next,
      foldRoster([
        change(1, 'ADD', 'g1', 'Kayza'),
        change(2, 'ADD', 'g2', 'Mantequay'),
        change(3, 'DEACTIVATE', 'g1', 'Kayza'),
        change(4, 'ADD', 'g4', 'Grizzly'),
      ]),
    );
  });

  test('a gap, a repeat or a version out of order fails', () => {
    for (const changes of [
      [change(2, 'ADD', 'g1', 'Kayza')],
      [change(1, 'ADD', 'g1', 'Kayza'), change(3, 'ADD', 'g2', 'Mantequay')],
      [change(1, 'ADD', 'g1', 'Kayza'), change(1, 'ADD', 'g2', 'Mantequay')],
      [change(0, 'ADD', 'g1', 'Kayza')],
    ]) {
      assert.throws(() => foldRoster(changes), RosterIntegrityError);
    }
    assert.throws(
      () =>
        foldRoster(
          [change(2, 'ADD', 'g9', 'Grizzly')],
          rosterOf('Kayza', 'Mantequay'),
        ),
      /Expected roster version 3, found 2/,
    );
  });

  test('a repeated add of one gamertagId fails', () => {
    assert.throws(
      () =>
        foldRoster([
          change(1, 'ADD', 'g1', 'Kayza'),
          change(2, 'DEACTIVATE', 'g1', 'Kayza'),
          change(3, 'ADD', 'g1', 'Kayza'),
        ]),
      (error: unknown) =>
        error instanceof RosterIntegrityError &&
        error.name === 'RosterIntegrityError' &&
        /adds existing entry g1/.test(error.message),
    );
  });

  test('an action on an entry in the wrong state, or on no entry, fails', () => {
    for (const changes of [
      [change(1, 'ADD', 'g1', 'Kayza'), change(2, 'REACTIVATE', 'g1', 'Kayza')],
      [
        change(1, 'ADD', 'g1', 'Kayza'),
        change(2, 'DEACTIVATE', 'g1', 'Kayza'),
        change(3, 'DEACTIVATE', 'g1', 'Kayza'),
      ],
      [change(1, 'DEACTIVATE', 'g1', 'Kayza')],
      [change(1, 'REACTIVATE', 'g1', 'Kayza')],
    ]) {
      assert.throws(() => foldRoster(changes), RosterIntegrityError);
    }
  });

  test('an unknown action fails', () => {
    assert.throws(
      () =>
        foldRoster([
          change(1, 'ADD', 'g1', 'Kayza'),
          change(2, 'DELETE' as RosterChangeAction, 'g1', 'Kayza'),
        ]),
      /Version 2 has unknown action DELETE/,
    );
  });

  test('integrity errors never name a gamertag', () => {
    assert.throws(
      () => foldRoster([change(1, 'DEACTIVATE', 'g1', 'Kayza')]),
      (error: Error) => !error.message.includes('Kayza'),
    );
  });
});

describe('activeEntries', () => {
  test('lists active entries by gamertagId, bytewise', () => {
    const roster = foldRoster([
      change(1, 'ADD', 'b', 'Second'),
      change(2, 'ADD', 'B', 'Upper'),
      change(3, 'ADD', 'a', 'First'),
      change(4, 'ADD', 'c', 'Gone'),
      change(5, 'DEACTIVATE', 'c', 'Gone'),
    ]);
    assert.deepEqual(activeEntries(roster), [
      { gamertagId: 'B', gamertag: 'Upper' },
      { gamertagId: 'a', gamertag: 'First' },
      { gamertagId: 'b', gamertag: 'Second' },
    ]);
  });
});

describe('rosterSha256 (spec 1.2 §5.1)', () => {
  test('the empty roster hashes []', () => {
    assert.equal(
      rosterSha256([]),
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
    assert.equal(rosterSha256(EMPTY_ROSTER.entries), hashOf('[]'));
  });

  test('hashes sorted entries with sorted keys and no whitespace', () => {
    assert.equal(
      rosterSha256([
        { gamertagId: 'g2', gamertag: 'Mantequay' },
        { gamertag: 'Kayza', gamertagId: 'g1' },
      ]),
      hashOf(
        '[{"gamertag":"Kayza","gamertagId":"g1"},{"gamertag":"Mantequay","gamertagId":"g2"}]',
      ),
    );
  });

  test('sorts gamertagId by UTF-8 bytes', () => {
    // U+FF21 sorts after U+1F600 in UTF-16 units but before it in UTF-8 bytes.
    assert.equal(
      rosterSha256([
        { gamertagId: '\u{1f600}', gamertag: 'Mantequay' },
        { gamertagId: 'Ａ', gamertag: 'Kayza' },
      ]),
      hashOf(
        '[{"gamertag":"Kayza","gamertagId":"Ａ"},{"gamertag":"Mantequay","gamertagId":"\u{1f600}"}]',
      ),
    );
  });

  test('does not depend on change order for the same active set', () => {
    const forward = rosterOf('Kayza', 'Mantequay', 'Grizzly');
    const reverse = foldRoster([
      change(1, 'ADD', 'g3', 'Grizzly'),
      change(2, 'ADD', 'g2', 'Mantequay'),
      change(3, 'ADD', 'g4', 'Thunderhawk'),
      change(4, 'ADD', 'g1', 'Kayza'),
      change(5, 'DEACTIVATE', 'g4', 'Thunderhawk'),
    ]);
    assert.equal(rosterSha256(forward.entries), rosterSha256(reverse.entries));
  });

  test('leaves inactive entries out', () => {
    const roster = foldRoster([
      change(1, 'ADD', 'g1', 'Kayza'),
      change(2, 'ADD', 'g2', 'Mantequay'),
      change(3, 'DEACTIVATE', 'g2', 'Mantequay'),
    ]);
    const expected = hashOf('[{"gamertag":"Kayza","gamertagId":"g1"}]');
    assert.equal(rosterSha256(roster.entries), expected);
    assert.equal(rosterSha256(activeEntries(roster)), expected);
  });
});

describe('checkChange (spec 1.2 §4.3)', () => {
  const add = (body: unknown): RosterChangeRequest => ({ action: 'ADD', body });
  const deactivate = (
    gamertagId: string,
    body: unknown = { clientRequestId: REQUEST_ID },
  ): RosterChangeRequest => ({
    action: 'DEACTIVATE',
    gamertagId,
    body,
  });
  const reactivate = (
    gamertagId: string,
    body: unknown = { clientRequestId: REQUEST_ID },
  ): RosterChangeRequest => ({
    action: 'REACTIVATE',
    gamertagId,
    body,
  });

  function refusal(
    result: AcceptedRosterChange | RosterRefusal,
  ): Omit<RosterRefusal, 'message' | 'entries'> & { entries: string[] } {
    assert.equal(result.accepted, false);
    const { accepted, status, code, entries } = result;
    return {
      accepted,
      status,
      code,
      entries: entries.map((entry) => entry.gamertagId),
    };
  }

  const roster = foldRoster([
    change(1, 'ADD', 'g1', 'Kayza'),
    change(2, 'ADD', 'g2', 'Mantequay'),
    change(3, 'ADD', 'g3', 'Old Name'),
    change(4, 'DEACTIVATE', 'g3', 'Old Name'),
    change(5, 'ADD', 'g5', 'Grizzly'),
  ]);

  test('accepts an add with the validated gamertag and no entry ID', () => {
    assert.deepEqual(
      checkChange(
        roster,
        add({
          gamertag: '  Thunder   Hawk  ',
          reason: 'joined',
          clientRequestId: REQUEST_ID,
        }),
      ),
      {
        accepted: true,
        action: 'ADD',
        gamertagId: null,
        gamertag: 'Thunder Hawk',
        reason: 'joined',
        clientRequestId: REQUEST_ID,
        warnings: { nearKeyGamertags: [] },
      },
    );
  });

  test('accepts gamertags with a suffix and at the length limit', () => {
    for (const gamertag of ['Player 1#1234', 'A'.repeat(16), 'x']) {
      const result = checkChange(
        roster,
        add({ gamertag, clientRequestId: REQUEST_ID }),
      );
      assert.equal(result.accepted, true, gamertag);
      assert.equal(result.reason, null);
    }
  });

  test('refuses a body that fails the schema with 400 INVALID_REQUEST', () => {
    for (const body of [
      null,
      'Thunderhawk',
      [],
      {},
      { gamertag: 'Thunderhawk' },
      { gamertag: 'Thunderhawk', clientRequestId: 'not-a-uuid' },
      { gamertag: 42, clientRequestId: REQUEST_ID },
      { gamertag: 'Thunderhawk', clientRequestId: REQUEST_ID, reason: 7 },
      { gamertag: 'Thunderhawk', clientRequestId: REQUEST_ID, reason: null },
      {
        gamertag: 'Thunderhawk',
        clientRequestId: REQUEST_ID,
        reason: 'r'.repeat(257),
      },
      {
        gamertag: 'Thunderhawk',
        clientRequestId: REQUEST_ID,
        actorArn: 'arn:aws:iam::000000000000:user/x',
      },
      {
        gamertag: 'Thunderhawk',
        clientRequestId: REQUEST_ID,
        allowSharedKey: true,
      },
    ]) {
      assert.deepEqual(
        refusal(checkChange(roster, add(body))),
        {
          accepted: false,
          status: 400,
          code: 'INVALID_REQUEST',
          entries: [],
        },
        JSON.stringify(body),
      );
    }
    assert.equal(
      checkChange(
        roster,
        add({
          gamertag: 'Thunderhawk',
          clientRequestId: REQUEST_ID,
          reason: 'r'.repeat(256),
        }),
      ).accepted,
      true,
    );
    for (const body of [
      { clientRequestId: REQUEST_ID, gamertag: 'Kayza' },
      { reason: 'x' },
    ]) {
      assert.equal(
        refusal(checkChange(roster, deactivate('g1', body))).code,
        'INVALID_REQUEST',
      );
      assert.equal(
        refusal(checkChange(roster, reactivate('g3', body))).code,
        'INVALID_REQUEST',
      );
    }
  });

  test('refuses a gamertag that fails the pattern with 400 INVALID_GAMERTAG', () => {
    for (const gamertag of [
      '',
      '   ',
      'A'.repeat(17),
      'Bad-Name',
      'Näme',
      'Name#12345',
      'Name#',
      '#123',
    ]) {
      assert.deepEqual(
        refusal(
          checkChange(roster, add({ gamertag, clientRequestId: REQUEST_ID })),
        ),
        { accepted: false, status: 400, code: 'INVALID_GAMERTAG', entries: [] },
        gamertag,
      );
    }
  });

  test('refuses an unknown gamertagId with 404 GAMERTAG_NOT_FOUND', () => {
    for (const request of [deactivate('g9'), reactivate('g9')]) {
      assert.deepEqual(refusal(checkChange(roster, request)), {
        accepted: false,
        status: 404,
        code: 'GAMERTAG_NOT_FOUND',
        entries: [],
      });
    }
  });

  test('refuses an add equal to any entry ignoring case with 409 DUPLICATE_GAMERTAG', () => {
    for (const [gamertag, id] of [
      ['KAYZA', 'g1'],
      ['kayza', 'g1'],
      ['old  name', 'g3'],
    ]) {
      assert.deepEqual(
        refusal(
          checkChange(roster, add({ gamertag, clientRequestId: REQUEST_ID })),
        ),
        {
          accepted: false,
          status: 409,
          code: 'DUPLICATE_GAMERTAG',
          entries: [id],
        },
        gamertag,
      );
    }
  });

  test('refuses an add whose key equals an active entry with 409 KEY_CONFLICT', () => {
    for (const [gamertag, id] of [
      ['Kay za', 'g1'],
      ['Grizz1y', 'g5'],
      ['Mantequay 1', null],
    ] as const) {
      const result = checkChange(
        roster,
        add({ gamertag, clientRequestId: REQUEST_ID }),
      );
      if (id === null) {
        assert.equal(result.accepted, true, gamertag);
        continue;
      }
      assert.deepEqual(
        refusal(result),
        { accepted: false, status: 409, code: 'KEY_CONFLICT', entries: [id] },
        gamertag,
      );
    }
  });

  test('a key shared only with an inactive entry is accepted', () => {
    assert.equal(
      checkChange(
        roster,
        add({ gamertag: '0ld Name', clientRequestId: REQUEST_ID }),
      ).accepted,
      true,
    );
  });

  test('refuses a reactivate whose key equals an active entry with 409 KEY_CONFLICT', () => {
    const conflicting = foldRoster(
      [change(6, 'ADD', 'g6', '0ld Name')],
      roster,
    );
    assert.deepEqual(refusal(checkChange(conflicting, reactivate('g3'))), {
      accepted: false,
      status: 409,
      code: 'KEY_CONFLICT',
      entries: ['g6'],
    });
  });

  test('refuses a state change that is already done with 409', () => {
    assert.deepEqual(refusal(checkChange(roster, deactivate('g3'))), {
      accepted: false,
      status: 409,
      code: 'ALREADY_INACTIVE',
      entries: [],
    });
    assert.deepEqual(refusal(checkChange(roster, reactivate('g1'))), {
      accepted: false,
      status: 409,
      code: 'ALREADY_ACTIVE',
      entries: [],
    });
  });

  test('accepts a deactivate and a reactivate of the entry in the route', () => {
    assert.deepEqual(
      checkChange(
        roster,
        deactivate('g1', { clientRequestId: REQUEST_ID, reason: 'left' }),
      ),
      {
        accepted: true,
        action: 'DEACTIVATE',
        gamertagId: 'g1',
        gamertag: 'Kayza',
        reason: 'left',
        clientRequestId: REQUEST_ID,
        warnings: { nearKeyGamertags: [] },
      },
    );
    assert.deepEqual(checkChange(roster, reactivate('g3')), {
      accepted: true,
      action: 'REACTIVATE',
      gamertagId: 'g3',
      gamertag: 'Old Name',
      reason: null,
      clientRequestId: REQUEST_ID,
      warnings: { nearKeyGamertags: [] },
    });
  });

  test('warns about active gamertags one key edit away', () => {
    const near = foldRoster(
      [
        change(6, 'ADD', 'g6', 'kayzq'),
        change(7, 'ADD', 'g7', 'Kayzz'),
        change(8, 'ADD', 'g8', 'Old Nam'),
      ],
      roster,
    );
    assert.deepEqual(
      (
        checkChange(
          near,
          add({ gamertag: 'Kayzx', clientRequestId: REQUEST_ID }),
        ) as AcceptedRosterChange
      ).warnings,
      { nearKeyGamertags: ['Kayza', 'kayzq', 'Kayzz'] },
    );
    assert.deepEqual(
      (checkChange(near, reactivate('g3')) as AcceptedRosterChange).warnings,
      { nearKeyGamertags: ['Old Nam'] },
    );
    // Two key edits away is not near.
    assert.deepEqual(
      (
        checkChange(
          near,
          add({ gamertag: 'Kayzaaa', clientRequestId: REQUEST_ID }),
        ) as AcceptedRosterChange
      ).warnings,
      { nearKeyGamertags: [] },
    );
    // Old Name is one key edit away but inactive, and Old Nam is two away.
    assert.deepEqual(
      (
        checkChange(
          near,
          add({ gamertag: 'Old Namez', clientRequestId: REQUEST_ID }),
        ) as AcceptedRosterChange
      ).warnings,
      { nearKeyGamertags: [] },
    );
  });

  test('accepts the 14 #91 placeholders one after another', () => {
    let current: Roster = EMPTY_ROSTER;
    for (const gamertag of [
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
    ]) {
      const result = checkChange(
        current,
        add({ gamertag, clientRequestId: REQUEST_ID }),
      );
      assert.equal(result.accepted, true, gamertag);
      const version = current.rosterVersion + 1;
      current = foldRoster(
        [change(version, 'ADD', `g${version}`, gamertag)],
        current,
      );
    }
    assert.equal(activeEntries(current).length, 14);
  });
});
