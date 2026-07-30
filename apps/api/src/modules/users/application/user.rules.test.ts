import { describe, expect, it } from 'vitest';
import {
  assertMayAdminister,
  assertMayGrant,
  assertNotLastOwner,
  assertNotSelf,
  highestRole,
} from './user.rules';

describe('highestRole', () => {
  it('returns null when someone has no memberships', () => {
    expect(highestRole([])).toBeNull();
  });

  it('takes the most senior across memberships, not the first', () => {
    expect(
      highestRole([
        { role: 'FRONT_DESK', propertyId: 'p1' },
        { role: 'ADMIN', propertyId: null },
        { role: 'READ_ONLY', propertyId: 'p2' },
      ]),
    ).toBe('ADMIN');
  });
});

describe('assertMayGrant', () => {
  it('allows granting at or below the actor level', () => {
    expect(() => assertMayGrant('ADMIN', 'ADMIN')).not.toThrow();
    expect(() => assertMayGrant('OWNER', 'ADMIN')).not.toThrow();
  });

  // An ADMIN holds user:invite, so only this stops them minting an OWNER and
  // then being administered by the account they just created.
  it('refuses to grant a role more senior than the actor', () => {
    expect(() => assertMayGrant('ADMIN', 'OWNER')).toThrow(/user:manage-roles/);
    expect(() => assertMayGrant('MANAGER', 'ADMIN')).toThrow();
  });

  it('refuses when the actor has no role at all', () => {
    expect(() => assertMayGrant(null, 'READ_ONLY')).toThrow();
  });
});

describe('assertMayAdminister', () => {
  it('allows acting on peers and juniors', () => {
    expect(() => assertMayAdminister('OWNER', 'OWNER')).not.toThrow();
    expect(() => assertMayAdminister('ADMIN', 'MANAGER')).not.toThrow();
  });

  it('refuses to let a junior act on a senior', () => {
    expect(() => assertMayAdminister('ADMIN', 'OWNER')).toThrow();
  });

  it('allows acting on someone with no role', () => {
    expect(() => assertMayAdminister('ADMIN', null)).not.toThrow();
  });
});

/**
 * Unit-tested rather than through HTTP on purpose.
 *
 * No request can reach this today — the seniority and self rules mean a second
 * active owner always exists by the time it runs — so an HTTP case would pass
 * whether or not the function did anything. These fail if it stops working.
 */
describe('assertNotLastOwner', () => {
  it('refuses when no other active owner remains', () => {
    expect(() => assertNotLastOwner(0)).toThrow(/only active owner/i);
  });

  it('allows the change when another active owner remains', () => {
    expect(() => assertNotLastOwner(1)).not.toThrow();
  });
});

describe('assertNotSelf', () => {
  it('refuses a self change', () => {
    expect(() => assertNotSelf('user-1', 'user-1')).toThrow(/your own/i);
  });

  it('allows acting on someone else', () => {
    expect(() => assertNotSelf('user-1', 'user-2')).not.toThrow();
  });

  // A system actor has no user id; it is not "itself" for this purpose.
  it('allows an actor with no user id', () => {
    expect(() => assertNotSelf(null, 'user-1')).not.toThrow();
  });
});
