import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  canAccessProperty,
  capabilitiesFor,
  effectiveCapabilities,
  grantedCapabilities,
  outranksOrEquals,
  roleRank,
  ROLES,
  type Membership,
} from './capabilities';

const PROPERTY_A = 'property-a';
const PROPERTY_B = 'property-b';

describe('capabilitiesFor()', () => {
  it('gives OWNER everything', () => {
    expect(capabilitiesFor('OWNER').size).toBe(CAPABILITIES.length);
  });

  it('gives READ_ONLY only read capabilities', () => {
    for (const capability of capabilitiesFor('READ_ONLY')) {
      expect(capability.endsWith(':read')).toBe(true);
    }
  });

  it('does not let READ_ONLY create a reservation', () => {
    expect(capabilitiesFor('READ_ONLY').has('reservation:create')).toBe(false);
  });

  it('lets FRONT_DESK take and cancel bookings but not change rates', () => {
    const frontDesk = capabilitiesFor('FRONT_DESK');
    expect(frontDesk.has('reservation:create')).toBe(true);
    expect(frontDesk.has('reservation:cancel')).toBe(true);
    expect(frontDesk.has('reservation:checkin')).toBe(true);
    // Commercial control belongs to a manager.
    expect(frontDesk.has('rate:update')).toBe(false);
    expect(frontDesk.has('inventory:update')).toBe(false);
  });

  it('lets MANAGER control inventory and rates but not invite users', () => {
    const manager = capabilitiesFor('MANAGER');
    expect(manager.has('inventory:update')).toBe(true);
    expect(manager.has('rate:update')).toBe(true);
    expect(manager.has('channel:sync')).toBe(true);
    expect(manager.has('user:invite')).toBe(false);
    expect(manager.has('org:update')).toBe(false);
  });

  it('lets ADMIN administer the organization but not manage roles', () => {
    const admin = capabilitiesFor('ADMIN');
    expect(admin.has('user:invite')).toBe(true);
    expect(admin.has('property:create')).toBe(true);
    // Only an OWNER may hand out roles, including ownership.
    expect(admin.has('user:manage-roles')).toBe(false);
  });

  it('nests roles: each level includes the one below', () => {
    for (const [lower, higher] of [
      ['READ_ONLY', 'FRONT_DESK'],
      ['FRONT_DESK', 'MANAGER'],
      ['MANAGER', 'ADMIN'],
      ['ADMIN', 'OWNER'],
    ] as const) {
      for (const capability of capabilitiesFor(lower)) {
        expect(capabilitiesFor(higher).has(capability)).toBe(true);
      }
    }
  });

  it('covers every declared role', () => {
    for (const role of ROLES) {
      expect(capabilitiesFor(role).size).toBeGreaterThan(0);
    }
  });
});

describe('effectiveCapabilities()', () => {
  it('applies an organization-wide membership to any property', () => {
    const memberships: Membership[] = [{ role: 'MANAGER', propertyId: null }];
    expect(effectiveCapabilities(memberships, PROPERTY_A).has('inventory:update')).toBe(true);
    expect(effectiveCapabilities(memberships, PROPERTY_B).has('inventory:update')).toBe(true);
  });

  it('confines a property-scoped membership to that property', () => {
    const memberships: Membership[] = [{ role: 'MANAGER', propertyId: PROPERTY_A }];
    expect(effectiveCapabilities(memberships, PROPERTY_A).has('inventory:update')).toBe(true);
    expect(effectiveCapabilities(memberships, PROPERTY_B).has('inventory:update')).toBe(false);
    expect(effectiveCapabilities(memberships, PROPERTY_B).size).toBe(0);
  });

  it('unions memberships rather than letting the narrower one win', () => {
    // An org-wide ADMIN who also holds FRONT_DESK at one property must not lose
    // admin rights at that property.
    const memberships: Membership[] = [
      { role: 'ADMIN', propertyId: null },
      { role: 'FRONT_DESK', propertyId: PROPERTY_A },
    ];
    const atA = effectiveCapabilities(memberships, PROPERTY_A);
    expect(atA.has('user:invite')).toBe(true);
    expect(atA.has('reservation:create')).toBe(true);
  });

  it('grants nothing without a membership', () => {
    expect(effectiveCapabilities([], PROPERTY_A).size).toBe(0);
  });

  it('ignores property-scoped memberships when asked organization-wide', () => {
    const memberships: Membership[] = [{ role: 'OWNER', propertyId: PROPERTY_A }];
    // Organization-wide questions must not be answered by a single property role.
    expect(effectiveCapabilities(memberships, null).size).toBe(0);
  });
});

describe('grantedCapabilities()', () => {
  it('reports what a property-scoped user can do somewhere', () => {
    // effectiveCapabilities(_, null) is empty for a property-scoped role, which
    // would leave the dashboard unable to render anything for a front-desk user.
    const memberships: Membership[] = [{ role: 'FRONT_DESK', propertyId: PROPERTY_A }];
    expect(effectiveCapabilities(memberships, null).size).toBe(0);
    expect(grantedCapabilities(memberships).has('reservation:create')).toBe(true);
  });

  it('unions across properties', () => {
    const memberships: Membership[] = [
      { role: 'READ_ONLY', propertyId: PROPERTY_A },
      { role: 'MANAGER', propertyId: PROPERTY_B },
    ];
    expect(grantedCapabilities(memberships).has('inventory:update')).toBe(true);
  });

  it('is empty without memberships', () => {
    expect(grantedCapabilities([]).size).toBe(0);
  });
});

describe('canAccessProperty()', () => {
  it('allows organization-wide members everywhere', () => {
    expect(canAccessProperty([{ role: 'READ_ONLY', propertyId: null }], PROPERTY_A)).toBe(true);
  });

  it('allows a property member only at their property', () => {
    const memberships: Membership[] = [{ role: 'MANAGER', propertyId: PROPERTY_A }];
    expect(canAccessProperty(memberships, PROPERTY_A)).toBe(true);
    expect(canAccessProperty(memberships, PROPERTY_B)).toBe(false);
  });

  it('denies a user with no memberships', () => {
    expect(canAccessProperty([], PROPERTY_A)).toBe(false);
  });
});

describe('role seniority', () => {
  it('ranks OWNER most senior and READ_ONLY least', () => {
    expect(roleRank('OWNER')).toBeLessThan(roleRank('ADMIN'));
    expect(roleRank('ADMIN')).toBeLessThan(roleRank('MANAGER'));
    expect(roleRank('MANAGER')).toBeLessThan(roleRank('FRONT_DESK'));
    expect(roleRank('FRONT_DESK')).toBeLessThan(roleRank('READ_ONLY'));
  });

  it('lets a role act on its own level', () => {
    expect(outranksOrEquals('ADMIN', 'ADMIN')).toBe(true);
  });

  /**
   * The rule capabilities cannot express. An ADMIN holds `user:invite`, and
   * without this an ADMIN could create an OWNER — handing away more authority
   * than they hold.
   */
  it('refuses to let a junior role act on a senior one', () => {
    expect(outranksOrEquals('ADMIN', 'OWNER')).toBe(false);
    expect(outranksOrEquals('MANAGER', 'ADMIN')).toBe(false);
    expect(outranksOrEquals('READ_ONLY', 'FRONT_DESK')).toBe(false);
  });

  it('lets a senior role act on a junior one', () => {
    expect(outranksOrEquals('OWNER', 'READ_ONLY')).toBe(true);
    expect(outranksOrEquals('ADMIN', 'MANAGER')).toBe(true);
  });
});
