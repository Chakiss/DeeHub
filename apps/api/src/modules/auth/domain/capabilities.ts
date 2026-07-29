/**
 * Capability-based authorization (architecture.md §10).
 *
 * Code checks capabilities, never role names. `if (role === 'MANAGER')`
 * scattered through controllers is how permission bugs happen: adding a role
 * then means auditing every comparison. Here a role is just a bundle of
 * capabilities, resolved in one place.
 */

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'READ_ONLY'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'org:read',
  'org:update',
  'user:read',
  'user:invite',
  'user:update',
  'user:manage-roles',
  'property:read',
  'property:create',
  'property:update',
  'roomtype:read',
  'roomtype:create',
  'roomtype:update',
  'room:read',
  'room:create',
  'room:update',
  'rateplan:read',
  'rateplan:create',
  'rateplan:update',
  'inventory:read',
  'inventory:update',
  'rate:read',
  'rate:update',
  'reservation:read',
  'reservation:create',
  'reservation:update',
  'reservation:modify',
  'reservation:cancel',
  'reservation:checkin',
  'reservation:checkout',
  'guest:read',
  'guest:update',
  'channel:read',
  'channel:create',
  'channel:update',
  'channel:sync',
  'audit:read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const READ_ONLY_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter((capability) =>
  capability.endsWith(':read'),
);

/** Day-to-day front-desk work: take bookings, check guests in and out. */
const FRONT_DESK_CAPABILITIES: readonly Capability[] = [
  ...READ_ONLY_CAPABILITIES,
  'reservation:create',
  'reservation:update',
  'reservation:modify',
  'reservation:cancel',
  'reservation:checkin',
  'reservation:checkout',
  'guest:update',
];

/** Runs a property: front-desk work plus commercial control. */
const MANAGER_CAPABILITIES: readonly Capability[] = [
  ...FRONT_DESK_CAPABILITIES,
  'inventory:update',
  'rate:update',
  'roomtype:create',
  'roomtype:update',
  'room:create',
  'room:update',
  'rateplan:create',
  'rateplan:update',
  'channel:update',
  'channel:sync',
];

/** Runs the organization: everything except transferring ownership. */
const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MANAGER_CAPABILITIES,
  'org:read',
  'org:update',
  'user:read',
  'user:invite',
  'user:update',
  'property:create',
  'property:update',
  'channel:create',
];

const ROLE_CAPABILITIES: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  OWNER: new Set(CAPABILITIES),
  ADMIN: new Set(ADMIN_CAPABILITIES),
  MANAGER: new Set(MANAGER_CAPABILITIES),
  FRONT_DESK: new Set(FRONT_DESK_CAPABILITIES),
  READ_ONLY: new Set(READ_ONLY_CAPABILITIES),
};

export function capabilitiesFor(role: Role): ReadonlySet<Capability> {
  return ROLE_CAPABILITIES[role];
}

export interface Membership {
  readonly role: Role;
  /** null = organization-wide. */
  readonly propertyId: string | null;
}

/**
 * Effective capabilities for a property, or organization-wide when
 * `propertyId` is null.
 *
 * A user's permissions are the UNION across their applicable memberships: an
 * org-wide ADMIN who is also FRONT_DESK at one property does not lose admin
 * rights there.
 */
export function effectiveCapabilities(
  memberships: readonly Membership[],
  propertyId: string | null,
): ReadonlySet<Capability> {
  const result = new Set<Capability>();
  for (const membership of memberships) {
    const applies =
      membership.propertyId === null ||
      (propertyId !== null && membership.propertyId === propertyId);
    if (!applies) continue;
    for (const capability of capabilitiesFor(membership.role)) {
      result.add(capability);
    }
  }
  return result;
}

/**
 * Everything the user can do SOMEWHERE, ignoring scope.
 *
 * For UI affordances only — deciding which navigation and buttons to render.
 * `effectiveCapabilities(memberships, propertyId)` remains the authority for
 * whether an action is permitted, and the server always re-checks per request;
 * this is deliberately broader and must never be used to authorize anything.
 */
export function grantedCapabilities(memberships: readonly Membership[]): ReadonlySet<Capability> {
  const result = new Set<Capability>();
  for (const membership of memberships) {
    for (const capability of capabilitiesFor(membership.role)) {
      result.add(capability);
    }
  }
  return result;
}

/** Whether the user may act on this property at all. */
export function canAccessProperty(memberships: readonly Membership[], propertyId: string): boolean {
  return memberships.some(
    (membership) => membership.propertyId === null || membership.propertyId === propertyId,
  );
}
