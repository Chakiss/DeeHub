import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { nightsBetween, toIsoDate } from '@deehub/shared';
import type { Executor } from '../../../database/executor';
import { ENV, type Env } from '../../../config/env';
import { newId } from '../../../common/ids';
import {
  channels,
  notifications,
  properties,
  reservationStays,
  reservations,
} from '../../../database/schema';
import {
  dedupeKey,
  type BookingSummary,
  type ComposedNotification,
  type NotificationKind,
} from '../domain/notification';
import { localeFor, render } from '../domain/templates';

export interface ComposeInput {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly kind: NotificationKind;
}

/**
 * Turn something that happened into the messages it owes, and store them.
 *
 * Composition and delivery are separate on purpose. Rendering needs the
 * booking, which is in the database this transaction is already in; sending
 * needs the network, which must never be inside a transaction holding row
 * locks. So this writes rows and stops.
 *
 * Storing the RENDERED text rather than a template name is the other half of
 * that: the log then answers "what was this guest told", not "what would we
 * tell them if it happened today".
 */
@Injectable()
export class ComposeNotificationsUseCase {
  private readonly logger = new Logger(ComposeNotificationsUseCase.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Returns how many rows were written; 0 when they already existed. */
  async execute(tx: Executor, input: ComposeInput): Promise<number> {
    const booking = await this.loadBooking(tx, input.reservationId);
    if (!booking) {
      // The booking was deleted between the event and this pass. Nothing to
      // say to anyone, and not an error worth failing the relay over.
      this.logger.warn(`No booking ${input.reservationId} to compose ${input.kind} for`);
      return 0;
    }

    const composed =
      input.kind === 'BOOKING_RECEIVED'
        ? this.forStaff(input.kind, booking.summary, booking.locale, booking.staffEmail)
        : this.forGuest(input.kind, booking.summary, booking.locale, booking.bookerEmail);

    if (composed.length === 0) return 0;

    const rows = composed.map((message) => ({
      id: newId(),
      organizationId: input.organizationId,
      propertyId: booking.propertyId,
      kind: message.kind,
      channel: message.channel,
      audience: message.audience,
      recipient: message.recipient,
      locale: message.locale,
      subject: message.subject,
      body: message.body,
      // A message with no recipient is stored SKIPPED rather than dropped: a
      // hotel that never confirms anything should be able to SEE that, and a
      // silent absence looks identical to a system that is working.
      status: message.recipient === '' ? 'SKIPPED' : 'PENDING',
      ...(message.recipient === '' ? { skippedReason: skipReason(message.audience) } : {}),
      reservationId: booking.summary.reservationId,
      context: {
        code: booking.summary.code,
        checkIn: booking.summary.checkIn,
        checkOut: booking.summary.checkOut,
      },
      dedupeKey: dedupeKey(message.kind, booking.summary.reservationId, message.channel),
    }));

    const inserted = await tx
      .insert(notifications)
      .values(rows)
      // The relay is at-least-once: a second pass over the same event must not
      // put a second confirmation in the guest's inbox.
      .onConflictDoNothing({ target: [notifications.organizationId, notifications.dedupeKey] })
      .returning({ id: notifications.id });

    return inserted.length;
  }

  private forGuest(
    kind: NotificationKind,
    summary: BookingSummary,
    locale: 'en' | 'th',
    bookerEmail: string | null,
  ): ComposedNotification[] {
    const message = render(kind, summary, locale);
    return [
      {
        kind,
        channel: 'EMAIL',
        audience: 'GUEST',
        recipient: bookerEmail ?? '',
        locale,
        subject: message.subject,
        body: message.body,
      },
    ];
  }

  /**
   * The desk gets it wherever the desk is looking.
   *
   * Email and LINE both, when both are configured, because these are the
   * messages somebody has to act on and a single channel that happens to be
   * muted is how an arrival goes unnoticed.
   */
  private forStaff(
    kind: NotificationKind,
    summary: BookingSummary,
    locale: 'en' | 'th',
    staffEmail: string | null,
  ): ComposedNotification[] {
    const message = render(kind, summary, locale);
    const out: ComposedNotification[] = [];

    const base = { kind, audience: 'STAFF' as const, locale, ...message };

    if (this.env.LINE_STAFF_TARGET) {
      out.push({ ...base, channel: 'LINE', recipient: this.env.LINE_STAFF_TARGET });
    }
    if (staffEmail) {
      out.push({ ...base, channel: 'EMAIL', recipient: staffEmail });
    }
    if (out.length === 0) {
      out.push({ ...base, channel: 'EMAIL', recipient: '' });
    }
    return out;
  }

  private async loadBooking(tx: Executor, reservationId: string) {
    const rows = await tx
      .select({
        reservationId: reservations.id,
        propertyId: reservations.propertyId,
        code: reservations.code,
        bookerName: reservations.bookerName,
        bookerEmail: reservations.bookerEmail,
        currency: reservations.currency,
        totalMinor: reservations.totalMinor,
        cancellationReason: reservations.cancellationReason,
        propertyName: properties.name,
        propertyPhone: properties.phone,
        propertyEmail: properties.email,
        country: properties.country,
        checkInTime: properties.checkInTime,
        checkOutTime: properties.checkOutTime,
        channelName: channels.name,
      })
      .from(reservations)
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .leftJoin(channels, eq(channels.id, reservations.channelId))
      .where(eq(reservations.id, reservationId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const spans = await tx
      .select({
        checkIn: sql<string>`MIN(${reservationStays.checkIn})`,
        checkOut: sql<string>`MAX(${reservationStays.checkOut})`,
        rooms: sql<number>`COUNT(*)::int`,
      })
      .from(reservationStays)
      .where(eq(reservationStays.reservationId, reservationId));

    const span = spans[0];
    if (!span?.checkIn || !span.checkOut) return null;

    const checkIn = toIsoDate(span.checkIn);
    const checkOut = toIsoDate(span.checkOut);

    const summary: BookingSummary = {
      reservationId: row.reservationId,
      code: row.code,
      propertyName: row.propertyName,
      propertyPhone: row.propertyPhone,
      // Stored as 'HH:MM:SS'; nobody needs the seconds.
      checkInTime: row.checkInTime.slice(0, 5),
      checkOutTime: row.checkOutTime.slice(0, 5),
      bookerName: row.bookerName,
      checkIn,
      checkOut,
      nights: nightsBetween(checkIn, checkOut).length,
      rooms: span.rooms,
      totalMinor: row.totalMinor,
      currency: row.currency,
      channelName: row.channelName,
      cancellationReason: row.cancellationReason,
    };

    return {
      propertyId: row.propertyId,
      bookerEmail: row.bookerEmail,
      staffEmail: row.propertyEmail,
      locale: localeFor(row.country),
      summary,
    };
  }
}

function skipReason(audience: 'GUEST' | 'STAFF'): string {
  return audience === 'GUEST'
    ? 'No email address on file for this booker'
    : 'No staff recipient: the property has no email address and LINE_STAFF_TARGET is not set';
}
