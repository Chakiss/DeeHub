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
  /*
   * Typing a price on a booking instead of taking the rate plan's. A discount
   * is revenue given away, so it is a capability of its own rather than part
   * of taking bookings: a receptionist takes bookings, a manager decides
   * what a room is worth tonight.
   */
  'reservation:price_override',
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
  /*
   * The hotel's own books (accounting-plan.md §6).
   *
   * Split three ways rather than one `accounting:*`, because the three answer
   * different questions about trust. Recording what the electricity cost is
   * the work of whoever runs the property. What the owner clears after those
   * costs, and the tax identity the business files under, are not — a manager
   * reading the profit and loss is a different disclosure from a manager
   * paying a bill, and small hotels are exactly where that distinction is
   * felt. Voiding is separated from writing for the reason `folio:void` is.
   */
  'expense:read',
  'expense:write',
  'expense:void',
  /** Profit and loss, the cash book, and every tax report. */
  'accounting:read',
  'accounting:settings',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Written out rather than computed.
 *
 * This was `CAPABILITIES.filter((c) => c.endsWith(':read'))`, which decided
 * who could see what by how a string was spelled. That is fine until a
 * capability arrives whose name ends in `:read` and whose contents nobody
 * would hand a receptionist — `folio:read` was already the warning, and
 * `expense:read` would have been the second one, granted silently by the act
 * of naming it.
 *
 * This list is the exact set the filter produced, so the refactor changes
 * nothing that existed before it. `folio:read` stays deliberately: narrowing
 * it is a live question for the founder in decisions-pending-review.md §15,
 * and answering it quietly here would bury the decision rather than make it.
 */
const READ_ONLY_CAPABILITIES: readonly Capability[] = [
  'org:read',
  'user:read',
  'property:read',
  'roomtype:read',
  'room:read',
  'rateplan:read',
  'inventory:read',
  'rate:read',
  'reservation:read',
  'guest:read',
  'channel:read',
  'audit:read',
  'notification:read',
  'folio:read',
];

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
  // The property's own description, address, coordinates and photos — what a
  // guest reads on the booking page and what Google matches a listing on.
  // Creating a property stays with ADMIN; tax identity stays with
  // `accounting:settings`.
  'property:update',
  'channel:update',
  'channel:sync',
  'reservation:price_override',
  'folio:void',
  // Buying the property's electricity is the job. Seeing what the owner keeps
  // after it is not — `accounting:read` stops at ADMIN.
  'expense:read',
  'expense:write',
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
  'channel:create',
  'expense:void',
  'accounting:read',
  'accounting:settings',
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
