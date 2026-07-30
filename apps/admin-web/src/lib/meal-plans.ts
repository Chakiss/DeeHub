/**
 * Shared vocabulary, safe on both sides of the network.
 *
 * Deliberately NOT in lib/api.ts. That module is `server-only` because it reads
 * the session cookie, so importing a runtime value from it into a client
 * component pulls `next/headers` into the browser bundle and the build fails.
 * Types are erased and can come from anywhere; values cannot.
 */
export const MEAL_PLANS = [
  'ROOM_ONLY',
  'BREAKFAST',
  'HALF_BOARD',
  'FULL_BOARD',
  'ALL_INCLUSIVE',
] as const;

export type MealPlan = (typeof MEAL_PLANS)[number];
