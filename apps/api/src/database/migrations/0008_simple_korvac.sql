CREATE VIEW "public"."effective_rate_days" AS (
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
);