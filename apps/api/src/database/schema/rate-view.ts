import { sql } from 'drizzle-orm';
import { bigint, char, date, pgView, smallint, uuid } from 'drizzle-orm/pg-core';

/**
 * Every rate plan's price for every night, whether it is stored or computed.
 *
 * A derived plan ("BAR minus 10%") keeps no rows of its own in `rate_days`; its
 * price is its parent's, offset. Something has to resolve that, and doing it in
 * application code would mean doing it in three places — the booking path, the
 * OTA push, and the availability grid's lead rate — which is three chances for
 * one of them to quote a different number than the guest was shown.
 *
 * So it is a VIEW. Every reader goes through it and none of them can disagree,
 * including whichever one gets written next.
 *
 * Two rules are encoded in the SQL and matter more than the arithmetic:
 *
 * **One level of derivation, no chains.** A derived plan reads its parent's
 * STORED rows, so a plan whose parent is itself derived resolves to nothing
 * rather than to a recursive discount. The application refuses to create one
 * (`assertDerivable`); this is what happens if it ever gets through anyway —
 * an absent price, which every caller already treats as "cannot be sold".
 *
 * **A computed price of zero or less is absent, not free.** Removing prices
 * rather than zeroing them is a rule the rate editor already follows: a
 * zero-priced night sells the room for nothing. A −100% derivation therefore
 * produces a night that cannot be booked, which is the safe reading of an
 * offset somebody typed wrong.
 */
export const effectiveRateDays = pgView('effective_rate_days', {
  organizationId: uuid('organization_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  ratePlanId: uuid('rate_plan_id').notNull(),
  date: date('date').notNull(),
  occupancy: smallint('occupancy').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
}).as(sql`
  SELECT rd.organization_id, rd.property_id, rd.rate_plan_id, rd.date, rd.occupancy,
         rd.amount_minor, rd.currency
    FROM rate_days rd
    JOIN rate_plans rp ON rp.id = rd.rate_plan_id
   WHERE rp.parent_rate_plan_id IS NULL

  UNION ALL

  SELECT rd.organization_id, rd.property_id, child.id, rd.date, rd.occupancy,
         CASE child.derivation_type
           -- Basis points, SIGNED: -1000 is ten percent off. numeric, not
           -- float, and round() away from zero to match roundHalfUp in
           -- pricing.ts — the two must agree or a quoted total and a folio
           -- line differ by a satang.
           WHEN 'PERCENTAGE'
             THEN round(rd.amount_minor::numeric * (10000 + child.derivation_value) / 10000)
           ELSE rd.amount_minor + child.derivation_value
         END::bigint,
         rd.currency
    FROM rate_plans child
    JOIN rate_plans parent ON parent.id = child.parent_rate_plan_id
    JOIN rate_days rd ON rd.rate_plan_id = parent.id
   WHERE child.parent_rate_plan_id IS NOT NULL
     -- One level only: a parent that is itself derived has no stored rows to
     -- read, and this makes that explicit rather than accidental.
     AND parent.parent_rate_plan_id IS NULL
     AND CASE child.derivation_type
           WHEN 'PERCENTAGE'
             THEN round(rd.amount_minor::numeric * (10000 + child.derivation_value) / 10000)
           ELSE rd.amount_minor + child.derivation_value
         END > 0
`);
