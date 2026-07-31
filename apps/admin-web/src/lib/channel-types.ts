/**
 * Channel types, mirroring the API's `CHANNEL_TYPES`.
 *
 * Its own module because this is a VALUE, and client components need it to
 * build the type picker. `lib/api.ts` is `server-only`; importing a value from
 * there into a client component typechecks fine and then fails the build,
 * because types are erased and arrays are not.
 */
export const CHANNEL_TYPES = [
  'MOCK_OTA',
  'AGODA',
  'BOOKING_COM',
  'EXPEDIA',
  'TRIP_COM',
  'AIRBNB',
  'DIRECT',
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
