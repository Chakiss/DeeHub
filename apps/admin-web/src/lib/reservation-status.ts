/**
 * The words shown for a reservation status.
 *
 * Statuses keep their long-standing plain wording ("checked in"); NO_SHOW is the
 * one with a translation, because "no show" is not something a Thai desk says.
 */
export function reservationStatusLabel(
  status: string,
  t: (key: 'statusNO_SHOW') => string,
): string {
  return status === 'NO_SHOW' ? t('statusNO_SHOW') : status.replace('_', ' ').toLowerCase();
}
