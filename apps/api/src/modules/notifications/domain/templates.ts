import { format, money } from '@deehub/shared';
import type { BookingSummary, NotificationKind } from './notification';

/**
 * What each message says, in Thai and English (ADR-0003).
 *
 * Pure functions over an already-loaded booking: no database, no clock, no
 * DI. A template is a thing a hotelier will want to argue about, so it has to
 * be readable on its own and testable without a running system.
 *
 * Plain text, not HTML. A confirmation that renders as a wall of broken markup
 * in one mail client is worse than one that renders everywhere, and the LINE
 * channel cannot show HTML at all — one body works for both.
 */

export type Locale = 'en' | 'th';

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}

/**
 * Thai for a Thai property, English otherwise.
 *
 * Keyed on the property's country rather than the guest's, because the guest's
 * language is not something DeeHub knows: nothing in the booking path asks for
 * it, and guessing from a name or an email domain would be worse than a
 * consistent default. When the booking engine starts collecting it, this is
 * the one place that changes.
 */
export function localeFor(country: string): Locale {
  return country.toUpperCase() === 'TH' ? 'th' : 'en';
}

export function render(
  kind: NotificationKind,
  booking: BookingSummary,
  locale: Locale,
): RenderedMessage {
  switch (kind) {
    case 'BOOKING_CONFIRMED':
      return locale === 'th' ? confirmedTh(booking) : confirmedEn(booking);
    case 'BOOKING_CANCELLED':
      return locale === 'th' ? cancelledTh(booking) : cancelledEn(booking);
    case 'BOOKING_RECEIVED':
      return locale === 'th' ? receivedTh(booking) : receivedEn(booking);
  }
}

/**
 * `คุณสมชาย`, but `คุณ Chakrit`.
 *
 * The honorific runs straight into a Thai name and is written with a space
 * before a Latin one. Getting this wrong is small and constant: every guest
 * with a romanised name reads a run-on word in the first line addressed to
 * them.
 */
function thaiHonorific(name: string): string {
  const trimmed = name.trim();
  return /^[\u0E00-\u0E7F]/.test(trimmed) ? `คุณ${trimmed}` : `คุณ ${trimmed}`;
}

function total(booking: BookingSummary, locale: Locale): string {
  return format(money(booking.totalMinor, booking.currency), locale === 'th' ? 'th-TH' : 'en-US');
}

/** Present only when the property filled it in; an empty line is not a line. */
function contactEn(booking: BookingSummary): string {
  return booking.propertyPhone ? `\nQuestions? Call us on ${booking.propertyPhone}.` : '';
}

function contactTh(booking: BookingSummary): string {
  return booking.propertyPhone ? `\nสอบถามเพิ่มเติม โทร ${booking.propertyPhone}` : '';
}

function confirmedEn(booking: BookingSummary): RenderedMessage {
  return {
    subject: `Booking ${booking.code} confirmed — ${booking.propertyName}`,
    body: `Dear ${booking.bookerName},

Your booking at ${booking.propertyName} is confirmed.

Reference    ${booking.code}
Check-in     ${booking.checkIn} from ${booking.checkInTime}
Check-out    ${booking.checkOut} by ${booking.checkOutTime}
Nights       ${String(booking.nights)}
Rooms        ${String(booking.rooms)}
Total        ${total(booking, 'en')}

We look forward to welcoming you.${contactEn(booking)}

${booking.propertyName}`,
  };
}

function confirmedTh(booking: BookingSummary): RenderedMessage {
  return {
    subject: `ยืนยันการจอง ${booking.code} — ${booking.propertyName}`,
    body: `เรียน ${thaiHonorific(booking.bookerName)}

การจองของท่านที่ ${booking.propertyName} ได้รับการยืนยันแล้ว

เลขที่การจอง  ${booking.code}
เช็คอิน       ${booking.checkIn} ตั้งแต่ ${booking.checkInTime} น.
เช็คเอาต์     ${booking.checkOut} ก่อน ${booking.checkOutTime} น.
จำนวนคืน     ${String(booking.nights)}
จำนวนห้อง    ${String(booking.rooms)}
ยอดรวม       ${total(booking, 'th')}

ทางโรงแรมยินดีต้อนรับท่าน${contactTh(booking)}

${booking.propertyName}`,
  };
}

function cancelledEn(booking: BookingSummary): RenderedMessage {
  const reason = booking.cancellationReason
    ? `\nReason recorded: ${booking.cancellationReason}\n`
    : '';
  return {
    subject: `Booking ${booking.code} cancelled — ${booking.propertyName}`,
    body: `Dear ${booking.bookerName},

Your booking at ${booking.propertyName} has been cancelled.

Reference    ${booking.code}
Was          ${booking.checkIn} to ${booking.checkOut}
${reason}
If this is not what you expected, please contact us — the booking can no longer be reinstated from this message.${contactEn(booking)}

${booking.propertyName}`,
  };
}

function cancelledTh(booking: BookingSummary): RenderedMessage {
  const reason = booking.cancellationReason
    ? `\nเหตุผลที่บันทึกไว้: ${booking.cancellationReason}\n`
    : '';
  return {
    subject: `ยกเลิกการจอง ${booking.code} — ${booking.propertyName}`,
    body: `เรียน ${thaiHonorific(booking.bookerName)}

การจองของท่านที่ ${booking.propertyName} ถูกยกเลิกแล้ว

เลขที่การจอง  ${booking.code}
ช่วงที่จองไว้  ${booking.checkIn} ถึง ${booking.checkOut}
${reason}
หากไม่ตรงกับที่ท่านตั้งใจ กรุณาติดต่อโรงแรม การจองนี้ไม่สามารถกู้คืนได้จากข้อความฉบับนี้${contactTh(booking)}

${booking.propertyName}`,
  };
}

/**
 * To the desk, about a booking nobody at the hotel typed in.
 *
 * Written to be read on a phone at 2am: what arrived, when the guest turns up,
 * and nothing else. The detail lives in the dashboard.
 */
function receivedEn(booking: BookingSummary): RenderedMessage {
  const source = booking.channelName ?? 'a channel';
  return {
    subject: `New booking ${booking.code} from ${source}`,
    body: `${booking.code} — ${source}
${booking.bookerName}
${booking.checkIn} to ${booking.checkOut} (${String(booking.nights)} night${booking.nights === 1 ? '' : 's'}, ${String(booking.rooms)} room${booking.rooms === 1 ? '' : 's'})
${total(booking, 'en')}

The room is already held. Assign it in the dashboard before arrival.`,
  };
}

function receivedTh(booking: BookingSummary): RenderedMessage {
  const source = booking.channelName ?? 'ช่องทางออนไลน์';
  return {
    subject: `การจองใหม่ ${booking.code} จาก ${source}`,
    body: `${booking.code} — ${source}
${booking.bookerName}
${booking.checkIn} ถึง ${booking.checkOut} (${String(booking.nights)} คืน, ${String(booking.rooms)} ห้อง)
${total(booking, 'th')}

ห้องถูกกันไว้แล้ว กรุณาจัดห้องในระบบก่อนแขกมาถึง`,
  };
}
