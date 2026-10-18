import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { RecipientChange, RecipientChangeAction } from '@mcc/contracts';
import {
  EMPTY_RECIPIENTS,
  MAX_ADDRESS_LENGTH,
  RecipientsIntegrityError,
  activeRecipients,
  checkRecipientChange,
  foldRecipients,
  normalizeAddress,
  recipientsSha256,
  type AcceptedRecipientChange,
  type RecipientChangeRequest,
  type RecipientList,
  type RecipientRefusal,
} from '../src/index';

const REQUEST_ID = '6f1c1a9e-3b0d-4c55-9f43-0e8a2b7d5c11';

function change(
  recipientsVersion: number,
  action: RecipientChangeAction,
  recipientId: string,
  address: string,
): RecipientChange {
  return {
    recipientsVersion,
    action,
    recipientId,
    address,
    reason: null,
    actorArn: 'arn:aws:sts::000000000000:assumed-role/test/operator',
    clientRequestId: REQUEST_ID,
    changedAt: '2026-10-18T00:00:00.000Z',
  };
}

/** Folds an add of each address, with IDs `r1`, `r2`, ... in order. */
function listOf(...addresses: string[]): RecipientList {
  return foldRecipients(
    addresses.map((address, index) =>
      change(index + 1, 'ADD', `r${index + 1}`, address),
    ),
  );
}

function hashOf(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

describe('foldRecipients', () => {
  test('an empty log is version 0 with no entries', () => {
    assert.deepEqual(foldRecipients([]), { recipientsVersion: 0, entries: [] });
    assert.deepEqual(foldRecipients([]), EMPTY_RECIPIENTS);
  });

  test('applies add, deactivate and reactivate in order', () => {
    const list = foldRecipients([
      change(1, 'ADD', 'r1', 'one@example.test'),
      change(2, 'ADD', 'r2', 'two@example.test'),
      change(3, 'DEACTIVATE', 'r1', 'one@example.test'),
      change(4, 'DEACTIVATE', 'r2', 'two@example.test'),
      change(5, 'REACTIVATE', 'r1', 'one@example.test'),
    ]);
    assert.deepEqual(list, {
      recipientsVersion: 5,
      entries: [
        {
          recipientId: 'r1',
          address: 'one@example.test',
          status: 'ACTIVE',
          addedVersion: 1,
          lastChangedVersion: 5,
        },
        {
          recipientId: 'r2',
          address: 'two@example.test',
          status: 'INACTIVE',
          addedVersion: 2,
          lastChangedVersion: 4,
        },
      ],
    });
  });

  test('folds later changes onto a cached list without changing it', () => {
    const cached = listOf('one@example.test', 'two@example.test');
    const snapshot = structuredClone(cached);
    const next = foldRecipients(
      [
        change(3, 'DEACTIVATE', 'r1', 'one@example.test'),
        change(4, 'ADD', 'r4', 'four@example.test'),
      ],
      cached,
    );
    assert.deepEqual(cached, snapshot);
    assert.deepEqual(
      next,
      foldRecipients([
        change(1, 'ADD', 'r1', 'one@example.test'),
        change(2, 'ADD', 'r2', 'two@example.test'),
        change(3, 'DEACTIVATE', 'r1', 'one@example.test'),
        change(4, 'ADD', 'r4', 'four@example.test'),
      ]),
    );
  });

  test('a gap, a repeat or a version out of order fails', () => {
    for (const changes of [
      [change(2, 'ADD', 'r1', 'one@example.test')],
      [
        change(1, 'ADD', 'r1', 'one@example.test'),
        change(3, 'ADD', 'r2', 'two@example.test'),
      ],
      [
        change(1, 'ADD', 'r1', 'one@example.test'),
        change(1, 'ADD', 'r2', 'two@example.test'),
      ],
      [change(0, 'ADD', 'r1', 'one@example.test')],
    ]) {
      assert.throws(() => foldRecipients(changes), RecipientsIntegrityError);
    }
    assert.throws(
      () =>
        foldRecipients(
          [change(2, 'ADD', 'r9', 'nine@example.test')],
          listOf('one@example.test', 'two@example.test'),
        ),
      /Expected recipients version 3, found 2/,
    );
  });

  test('a repeated add of one recipientId fails', () => {
    assert.throws(
      () =>
        foldRecipients([
          change(1, 'ADD', 'r1', 'one@example.test'),
          change(2, 'DEACTIVATE', 'r1', 'one@example.test'),
          change(3, 'ADD', 'r1', 'one@example.test'),
        ]),
      (error: unknown) =>
        error instanceof RecipientsIntegrityError &&
        error.name === 'RecipientsIntegrityError' &&
        /Version 3 adds existing entry r1/.test(error.message),
    );
  });

  test('an action on an entry in the wrong state, or on no entry, fails', () => {
    for (const changes of [
      [
        change(1, 'ADD', 'r1', 'one@example.test'),
        change(2, 'REACTIVATE', 'r1', 'one@example.test'),
      ],
      [
        change(1, 'ADD', 'r1', 'one@example.test'),
        change(2, 'DEACTIVATE', 'r1', 'one@example.test'),
        change(3, 'DEACTIVATE', 'r1', 'one@example.test'),
      ],
      [change(1, 'DEACTIVATE', 'r1', 'one@example.test')],
      [change(1, 'REACTIVATE', 'r1', 'one@example.test')],
    ]) {
      assert.throws(() => foldRecipients(changes), RecipientsIntegrityError);
    }
  });

  test('an unknown action fails', () => {
    assert.throws(
      () =>
        foldRecipients([
          change(1, 'ADD', 'r1', 'one@example.test'),
          change(
            2,
            'DELETE' as RecipientChangeAction,
            'r1',
            'one@example.test',
          ),
        ]),
      /Version 2 has unknown action DELETE/,
    );
  });

  test('integrity errors name versions and IDs, never an address', () => {
    for (const changes of [
      [change(1, 'DEACTIVATE', 'r1', 'secret@example.test')],
      [
        change(1, 'ADD', 'r1', 'secret@example.test'),
        change(2, 'ADD', 'r1', 'secret@example.test'),
      ],
      [change(2, 'ADD', 'r1', 'secret@example.test')],
    ]) {
      assert.throws(
        () => foldRecipients(changes),
        (error: unknown) =>
          error instanceof RecipientsIntegrityError &&
          !error.message.includes('secret'),
      );
    }
  });
});

describe('activeRecipients', () => {
  test('lists active entries sorted by recipientId bytewise', () => {
    const list = foldRecipients([
      change(1, 'ADD', 'b', 'bee@example.test'),
      change(2, 'ADD', 'B', 'big-bee@example.test'),
      change(3, 'ADD', 'a', 'ay@example.test'),
      change(4, 'DEACTIVATE', 'a', 'ay@example.test'),
    ]);
    assert.deepEqual(activeRecipients(list), [
      { recipientId: 'B', address: 'big-bee@example.test' },
      { recipientId: 'b', address: 'bee@example.test' },
    ]);
  });
});

describe('recipientsSha256', () => {
  test('the empty list hashes []', () => {
    assert.equal(recipientsSha256([]), hashOf('[]'));
    assert.equal(
      recipientsSha256([]),
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  test('hashes sorted keys and entries with no whitespace', () => {
    assert.equal(
      recipientsSha256([
        { recipientId: 'r2', address: 'two@example.test' },
        { recipientId: 'r1', address: 'One@Example.test' },
      ]),
      hashOf(
        '[{"address":"One@Example.test","recipientId":"r1"},{"address":"two@example.test","recipientId":"r2"}]',
      ),
    );
  });

  test('sorts by recipientId bytewise, not by locale', () => {
    assert.equal(
      recipientsSha256([
        { recipientId: 'b', address: 'bee@example.test' },
        { recipientId: 'B', address: 'big@example.test' },
      ]),
      hashOf(
        '[{"address":"big@example.test","recipientId":"B"},{"address":"bee@example.test","recipientId":"b"}]',
      ),
    );
  });

  test('ignores inactive entries and extra fields', () => {
    const list = foldRecipients([
      change(1, 'ADD', 'r1', 'one@example.test'),
      change(2, 'ADD', 'r2', 'two@example.test'),
      change(3, 'DEACTIVATE', 'r2', 'two@example.test'),
    ]);
    assert.equal(
      recipientsSha256(list.entries),
      hashOf('[{"address":"one@example.test","recipientId":"r1"}]'),
    );
    assert.equal(
      recipientsSha256(list.entries),
      recipientsSha256(activeRecipients(list)),
    );
  });
});

describe('normalizeAddress', () => {
  test('trims a valid address and keeps its case', () => {
    assert.equal(
      normalizeAddress('  Player@Example.test\t'),
      'Player@Example.test',
    );
    assert.equal(normalizeAddress('a@b'), 'a@b');
    assert.equal(
      normalizeAddress('first.last+tag@example.test'),
      'first.last+tag@example.test',
    );
  });

  test('refuses whitespace, commas, a missing part, or not exactly one @', () => {
    for (const text of [
      '',
      '   ',
      'player',
      '@example.test',
      'player@',
      'player@@example.test',
      'player@example@test',
      'pla yer@example.test',
      'player@example.test,other@example.test',
      'player@exam\tple.test',
      'player@example.test\nother',
      'player@exam ple.test',
    ]) {
      assert.equal(normalizeAddress(text), null, JSON.stringify(text));
    }
  });

  test(`accepts at most ${MAX_ADDRESS_LENGTH} characters after trimming`, () => {
    const longest = `${'a'.repeat(MAX_ADDRESS_LENGTH - '@example.test'.length)}@example.test`;
    assert.equal(longest.length, 254);
    assert.equal(normalizeAddress(` ${longest} `), longest);
    assert.equal(normalizeAddress(`a${longest}`), null);
  });
});

describe('checkRecipientChange', () => {
  const add = (
    address: string,
    extra: Partial<RecipientChangeRequest> = {},
  ): RecipientChangeRequest => ({
    action: 'ADD',
    address,
    clientRequestId: REQUEST_ID,
    ...extra,
  });
  const by = (
    action: RecipientChangeAction,
    address: string,
  ): RecipientChangeRequest => ({
    action,
    address,
    clientRequestId: REQUEST_ID,
  });
  const refused = (
    result: AcceptedRecipientChange | RecipientRefusal,
  ): RecipientRefusal => {
    assert.equal(result.accepted, false, JSON.stringify(result));
    return result;
  };
  const accepted = (
    result: AcceptedRecipientChange | RecipientRefusal,
  ): AcceptedRecipientChange => {
    assert.equal(result.accepted, true, JSON.stringify(result));
    return result;
  };

  // r1 active, r2 inactive.
  const list = foldRecipients([
    change(1, 'ADD', 'r1', 'One@Example.test'),
    change(2, 'ADD', 'r2', 'two@example.test'),
    change(3, 'DEACTIVATE', 'r2', 'two@example.test'),
  ]);

  test('an add returns the trimmed address and no ID', () => {
    assert.deepEqual(
      accepted(
        checkRecipientChange(
          list,
          add('  three@example.test ', { reason: 'new' }),
        ),
      ),
      {
        accepted: true,
        action: 'ADD',
        recipientId: null,
        address: 'three@example.test',
        reason: 'new',
        clientRequestId: REQUEST_ID,
      },
    );
    assert.equal(
      accepted(checkRecipientChange(EMPTY_RECIPIENTS, add('a@b'))).reason,
      null,
    );
  });

  test('an invalid address is INVALID_ADDRESS and names no address', () => {
    const result = refused(
      checkRecipientChange(list, add('secret,x@example.test')),
    );
    assert.equal(result.code, 'INVALID_ADDRESS');
    assert.deepEqual(result.entries, []);
    assert.ok(!result.message.includes('secret'));
  });

  test('an address on the list, active or inactive, in any case is DUPLICATE_ADDRESS', () => {
    for (const [address, recipientId] of [
      ['one@example.test', 'r1'],
      [' ONE@EXAMPLE.TEST ', 'r1'],
      ['Two@Example.Test', 'r2'],
    ]) {
      const result = refused(checkRecipientChange(list, add(address)));
      assert.equal(result.code, 'DUPLICATE_ADDRESS', address);
      assert.deepEqual(
        result.entries.map((entry) => entry.recipientId),
        [recipientId],
      );
      assert.ok(!result.message.toLowerCase().includes('example'));
    }
  });

  test('deactivate and reactivate find the entry ignoring case', () => {
    assert.deepEqual(
      accepted(
        checkRecipientChange(list, by('DEACTIVATE', ' one@EXAMPLE.test ')),
      ),
      {
        accepted: true,
        action: 'DEACTIVATE',
        recipientId: 'r1',
        address: 'One@Example.test',
        reason: null,
        clientRequestId: REQUEST_ID,
      },
    );
    const reactivate = accepted(
      checkRecipientChange(list, by('REACTIVATE', 'TWO@example.test')),
    );
    assert.equal(reactivate.recipientId, 'r2');
    assert.equal(reactivate.address, 'two@example.test');
  });

  test('no matching entry is RECIPIENT_NOT_FOUND', () => {
    for (const action of ['DEACTIVATE', 'REACTIVATE'] as const) {
      for (const address of [
        'three@example.test',
        'one@example',
        'not an address',
      ]) {
        const result = refused(checkRecipientChange(list, by(action, address)));
        assert.equal(result.code, 'RECIPIENT_NOT_FOUND');
        assert.deepEqual(result.entries, []);
      }
    }
  });

  test('more than one matching entry is RECIPIENT_NOT_FOUND with the entries', () => {
    const doubled = foldRecipients([
      change(1, 'ADD', 'r1', 'one@example.test'),
      change(2, 'ADD', 'r2', 'ONE@example.test'),
    ]);
    const result = refused(
      checkRecipientChange(doubled, by('DEACTIVATE', 'one@example.test')),
    );
    assert.equal(result.code, 'RECIPIENT_NOT_FOUND');
    assert.match(result.message, /More than one entry/);
    assert.deepEqual(
      result.entries.map((entry) => entry.recipientId),
      ['r1', 'r2'],
    );
  });

  test('deactivating an inactive entry and reactivating an active one are refused', () => {
    assert.equal(
      refused(checkRecipientChange(list, by('DEACTIVATE', 'two@example.test')))
        .code,
      'ALREADY_INACTIVE',
    );
    assert.equal(
      refused(checkRecipientChange(list, by('REACTIVATE', 'one@example.test')))
        .code,
      'ALREADY_ACTIVE',
    );
  });

  test('a bad clientRequestId, reason, address type or action is INVALID_REQUEST', () => {
    for (const request of [
      add('three@example.test', { clientRequestId: 'not-a-uuid' }),
      add('three@example.test', { reason: 'x'.repeat(257) }),
      add('three@example.test', { reason: 5 as unknown as string }),
      { ...add('x'), address: undefined as unknown as string },
      by('DELETE' as RecipientChangeAction, 'one@example.test'),
    ]) {
      assert.equal(
        refused(checkRecipientChange(list, request)).code,
        'INVALID_REQUEST',
        JSON.stringify(request),
      );
    }
    // A reason of 256 characters, counted as code points, is accepted.
    assert.equal(
      accepted(
        checkRecipientChange(
          list,
          add('three@example.test', { reason: '\u{1F600}'.repeat(256) }),
        ),
      ).reason?.length,
      512,
    );
  });
});
