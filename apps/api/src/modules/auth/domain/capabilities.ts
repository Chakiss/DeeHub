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
  /* Delivery log: what the hotel told guests and staff, and what failed. */
  'notification:read',
  /*
   * The guest's account: what they owe, what they have paid, the balance.
   *
   * `folio:read` is NOT in the blanket `:read` bundle by accident — it ends in
   * `:read`, so READ_ONLY receives it, which is the same call item 4 records
   * for the audit trail. A folio shows money rather than a name, so say if you
   * want it narrowed.
   *
   * Voiding is separated from posting on purpose. Recording a payment is the
   * everyday work of a front desk; unrecording one is how a till is made to
   * balance after money has gone missing, and it belongs to whoever is
   * accountable for the till rather than whoever is standing at it.
   */
  'folio:read',
  'folio:post',
  'folio:void',
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
  // Taking money is the job. Un-taking it is not — see `folio:void`.
  'folio:post',
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
  'folio:void',
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

/**
 * Seniority, from ROLES order: OWNER is 0 and the most senior.
 *
 * Used to stop privilege escalation. Capabilities alone cannot express it —
 * an ADMIN holds `user:invite`, and nothing in the capability check says the
 * invitee may not be made an OWNER, which would hand away more authority than
 * the inviter has.
 */
export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** True when `actor` is at least as senior as `target`. */
export function outranksOrEquals(actor: Role, target: Role): boolean {
  return roleRank(actor) <= roleRank(target);
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
