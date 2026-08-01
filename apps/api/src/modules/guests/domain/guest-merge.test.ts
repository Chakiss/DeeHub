import { describe, expect, it } from 'vitest';
import {
  confidenceOf,
  emailKey,
  mergeNotes,
  nameKey,
  phoneKey,
  rankCandidates,
  reconcile,
  signalsBetween,
  type DuplicateCandidate,
  type MergeableFields,
} from './guest-merge';
import type { GuestRecord } from './guest.repository';

function guest(overrides: Partial<GuestRecord> = {}): GuestRecord {
  return {
    id: 'g1',
    firstName: 'Somchai',
    lastName: 'Prasert',
    email: 'somchai@example.com',
    phone: '081 234 5678',
    nationality: 'TH',
    notes: null,
    ...overrides,
  };
}

function fields(overrides: Partial<MergeableFields> = {}): MergeableFields {
  return {
    lastName: null,
    email: null,
    phone: null,
    nationality: null,
    documentType: null,
    documentNumberEncrypted: null,
    dateOfBirth: null,
    notes: null,
    ...overrides,
  };
}

describe('phoneKey', () => {
  it('treats the local and international spellings of one mobile as equal', () => {
    // The case this exists for: a guest books once by phone and once through an
    // OTA that stores the number with a country code.
    expect(phoneKey('081 234 5678')).toBe(phoneKey('+66 81 234 5678'));
  });

  it('ignores punctuation', () => {
    expect(phoneKey('(081) 234-5678')).toBe(phoneKey('0812345678'));
  });

  it('refuses a number too short to identify anyone', () => {
    // An extension or a partial entry would otherwise match half the guest book.
    expect(phoneKey('1234')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it('keeps genuinely different numbers apart', () => {
    expect(phoneKey('0812345678')).not.toBe(phoneKey('0899999999'));
  });
});

describe('emailKey', () => {
  it('is case and whitespace insensitive', () => {
    expect(emailKey('  Somchai@Example.COM ')).toBe('somchai@example.com');
  });

  it('treats an empty address as absent', () => {
    expect(emailKey('   ')).toBeNull();
    expect(emailKey(null)).toBeNull();
  });
});

describe('nameKey', () => {
  it('needs both names', () => {
    // A first name alone matches half the guest book, so it is not a signal.
    expect(nameKey({ firstName: 'Somchai', lastName: null })).toBeNull();
    expect(nameKey({ firstName: '', lastName: 'Prasert' })).toBeNull();
  });

  it('is case insensitive', () => {
    expect(nameKey({ firstName: 'SOMCHAI', lastName: 'prasert' })).toBe(
      nameKey({ firstName: 'Somchai', lastName: 'Prasert' }),
    );
  });
});

describe('signalsBetween', () => {
  it('finds all three when everything agrees', () => {
    expect(signalsBetween(guest(), guest({ id: 'g2' }))).toEqual(['NAME', 'EMAIL', 'PHONE']);
  });

  it('finds nothing between two unrelated people', () => {
    const other = guest({
      id: 'g2',
      firstName: 'Nadia',
      lastName: 'Chen',
      email: 'nadia@example.com',
      phone: '0899999999',
    });
    expect(signalsBetween(guest(), other)).toEqual([]);
  });

  it('does not treat two missing values as a match', () => {
    // The bug this guards: null === null is true, and would make every
    // profile without an email a duplicate of every other one.
    const a = guest({ id: 'a', email: null, phone: null, lastName: null });
    const b = guest({ id: 'b', email: null, phone: null, lastName: null, firstName: 'Nadia' });
    expect(signalsBetween(a, b)).toEqual([]);
  });

  it('matches a mistyped email on name and phone alone', () => {
    const typo = guest({ id: 'g2', email: 'somchia@example.com' });
    expect(signalsBetween(guest(), typo)).toEqual(['NAME', 'PHONE']);
  });
});

describe('confidenceOf', () => {
  it('trusts a phone number on its own', () => {
    // People share an inbox far more often than a handset.
    expect(confidenceOf(['PHONE'])).toBe('HIGH');
  });

  it('does not trust an email on its own', () => {
    // A company books its staff through info@, a family uses one address.
    expect(confidenceOf(['EMAIL'])).toBe('MEDIUM');
  });

  it('trusts an email once a name agrees with it', () => {
    expect(confidenceOf(['NAME', 'EMAIL'])).toBe('HIGH');
  });

  it('barely trusts a name on its own', () => {
    // Common surnames repeat constantly in a Thai guest book.
    expect(confidenceOf(['NAME'])).toBe('LOW');
  });
});

describe('rankCandidates', () => {
  it('puts the strongest evidence first', () => {
    const weak: DuplicateCandidate = {
      guest: guest({ id: 'weak' }),
      signals: ['NAME'],
      confidence: 'LOW',
    };
    const medium: DuplicateCandidate = {
      guest: guest({ id: 'medium' }),
      signals: ['EMAIL'],
      confidence: 'MEDIUM',
    };
    const strong: DuplicateCandidate = {
      guest: guest({ id: 'strong' }),
      signals: ['NAME', 'EMAIL', 'PHONE'],
      confidence: 'HIGH',
    };

    expect(rankCandidates([weak, strong, medium]).map((c) => c.guest.id)).toEqual([
      'strong',
      'medium',
      'weak',
    ]);
  });

  it('breaks a tie by how many signals agree', () => {
    const one: DuplicateCandidate = {
      guest: guest({ id: 'one' }),
      signals: ['PHONE'],
      confidence: 'HIGH',
    };
    const three: DuplicateCandidate = {
      guest: guest({ id: 'three' }),
      signals: ['NAME', 'EMAIL', 'PHONE'],
      confidence: 'HIGH',
    };
    expect(rankCandidates([one, three]).map((c) => c.guest.id)).toEqual(['three', 'one']);
  });
});

describe('reconcile', () => {
  it('fills a blank on the survivor from the duplicate', () => {
    const changes = reconcile(fields({ email: null }), fields({ email: 'somchai@example.com' }));
    expect(changes.email).toBe('somchai@example.com');
  });

  it('never overwrites a value the survivor already has', () => {
    // The survivor's spelling is the one the operator chose by merging this way
    // round. Replacing it silently would make the direction meaningless.
    const changes = reconcile(
      fields({ email: 'kept@example.com' }),
      fields({ email: 'other@example.com' }),
    );
    expect(changes.email).toBeUndefined();
  });

  it('treats whitespace on the survivor as blank', () => {
    const changes = reconcile(fields({ phone: '   ' }), fields({ phone: '0812345678' }));
    expect(changes.phone).toBe('0812345678');
  });

  it('changes nothing when the duplicate adds nothing', () => {
    const survivor = fields({ email: 'a@b.co', phone: '0812345678', notes: 'VIP' });
    expect(reconcile(survivor, fields())).toEqual({});
  });

  it('carries a document number and its type across together', () => {
    const number = Buffer.from('encrypted');
    const changes = reconcile(
      fields(),
      fields({ documentType: 'PASSPORT', documentNumberEncrypted: number }),
    );
    // A number without its type records a passport as a national id.
    expect(changes.documentNumberEncrypted).toBe(number);
    expect(changes.documentType).toBe('PASSPORT');
  });

  it('keeps the survivor own document rather than the duplicate one', () => {
    const changes = reconcile(
      fields({ documentType: 'PASSPORT', documentNumberEncrypted: Buffer.from('mine') }),
      fields({ documentType: 'NATIONAL_ID', documentNumberEncrypted: Buffer.from('theirs') }),
    );
    expect(changes.documentNumberEncrypted).toBeUndefined();
    expect(changes.documentType).toBeUndefined();
  });
});

describe('mergeNotes', () => {
  it('keeps both, survivor first', () => {
    // A note is something a person wrote — an allergy, a complaint. Choosing
    // one would delete the thing nobody can reconstruct.
    expect(mergeNotes('Allergic to nuts', 'Prefers a high floor')).toBe(
      'Allergic to nuts\n\nPrefers a high floor',
    );
  });

  it('takes the duplicate note when the survivor has none', () => {
    expect(mergeNotes(null, 'Prefers a high floor')).toBe('Prefers a high floor');
  });

  it('leaves the survivor untouched when the duplicate has nothing to add', () => {
    expect(mergeNotes('Allergic to nuts', null)).toBe('Allergic to nuts');
    expect(mergeNotes('Allergic to nuts', '   ')).toBe('Allergic to nuts');
  });

  it('does not repeat a note the survivor already contains', () => {
    expect(mergeNotes('Allergic to nuts', 'Allergic to nuts')).toBe('Allergic to nuts');
  });

  it('stays null when neither has a note', () => {
    expect(mergeNotes(null, null)).toBeNull();
  });
});
