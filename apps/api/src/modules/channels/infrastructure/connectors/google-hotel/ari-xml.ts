import type { AriNight, AriPayload } from '../../../domain/channel-connector';
import { attrs, esc, major, runs, timestamp } from './xml';

/**
 * Google Hotel Prices ARI messages (developers.google.com/hotels/hotel-prices/xml-reference).
 *
 * Three documents per push, one identity: `HotelCode` is the property's
 * id — the same `<id>` the Hotel List Feed carries — `InvTypeCode` is the
 * room type's external id and `RatePlanCode` the rate plan's, both what the
 * channel mapping says they are.
 *
 * Prices go out AFTER tax and BEFORE tax both, per occupancy; Google shows
 * the guest the after-tax figure, which is what the booking page charges.
 */

export interface GoogleAriDocuments {
  readonly rates: string;
  readonly availability: string;
  readonly inventory: string;
}

const NS = 'xmlns="http://www.opentravel.org/OTA/2003/05"';

export function buildAriDocuments(
  hotelCode: string,
  payload: AriPayload,
  now: Date = new Date(),
): GoogleAriDocuments {
  const dates = payload.nights.map((night) => night.date);
  const byDate = new Map(payload.nights.map((night) => [night.date as string, night]));
  const echo = String(now.getTime());
  const head = `EchoToken="${esc(echo)}" TimeStamp="${esc(timestamp(now))}" Version="3.0"`;

  // --- Rates: one message per (plan, occupancy, run of equal prices) -------
  const planIds = [
    ...new Set(payload.nights.flatMap((night) => night.rates.map((rate) => rate.externalRateId))),
  ].sort();
  const rateMessages: string[] = [];
  for (const planId of planIds) {
    const occupancies = [
      ...new Set(
        payload.nights.flatMap((night) =>
          night.rates
            .filter((rate) => rate.externalRateId === planId)
            .map((rate) => rate.occupancy),
        ),
      ),
    ].sort((a, b) => a - b);
    for (const occupancy of occupancies) {
      const priced = runs(
        dates,
        (date) => {
          const rate = byDate
            .get(date)
            ?.rates.find((r) => r.externalRateId === planId && r.occupancy === occupancy);
          return rate
            ? { net: rate.amountMinor, gross: rate.grossMinor, currency: rate.currency }
            : undefined;
        },
        (a, b) => a.net === b.net && a.gross === b.gross && a.currency === b.currency,
      );
      for (const run of priced) {
        rateMessages.push(
          `<RateAmountMessage>` +
            `<StatusApplicationControl${attrs({ Start: run.start, End: run.end, InvTypeCode: payload.externalRoomId, RatePlanCode: planId })}/>` +
            `<Rates><Rate><BaseByGuestAmts>` +
            `<BaseByGuestAmt${attrs({ AmountBeforeTax: major(run.value.net), AmountAfterTax: major(run.value.gross), CurrencyCode: run.value.currency, NumberOfGuests: occupancy })}/>` +
            `</BaseByGuestAmts></Rate></Rates>` +
            `</RateAmountMessage>`,
        );
      }
      // Nights with no price for this plan/occupancy are removed, so a price
      // the hotel cleared does not linger on Google.
      const unpriced = runs(
        dates,
        (date) => {
          const rate = byDate
            .get(date)
            ?.rates.find((r) => r.externalRateId === planId && r.occupancy === occupancy);
          return rate ? undefined : true;
        },
        () => true,
      );
      for (const run of unpriced) {
        rateMessages.push(
          `<RateAmountMessage>` +
            `<StatusApplicationControl${attrs({ Start: run.start, End: run.end, InvTypeCode: payload.externalRoomId, RatePlanCode: planId })}/>` +
            `<Rates><Rate${attrs({ NotifType: 'Remove' })}/></Rates>` +
            `</RateAmountMessage>`,
        );
      }
    }
  }
  const rates =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<OTA_HotelRateAmountNotifRQ ${NS} ${head}>` +
    `<RateAmountMessages${attrs({ HotelCode: hotelCode })}>${rateMessages.join('')}</RateAmountMessages>` +
    `</OTA_HotelRateAmountNotifRQ>`;

  // --- Availability: open/close and restrictions, per plan -----------------
  const availMessages: string[] = [];
  const restrictionOf = (night: AriNight) => ({
    closed: night.stopSell || night.available <= 0,
    cta: night.closedToArrival,
    ctd: night.closedToDeparture,
    minStay: night.minStay,
    maxStay: night.maxStay,
  });
  const sameRestriction = (
    a: ReturnType<typeof restrictionOf>,
    b: ReturnType<typeof restrictionOf>,
  ) =>
    a.closed === b.closed &&
    a.cta === b.cta &&
    a.ctd === b.ctd &&
    a.minStay === b.minStay &&
    a.maxStay === b.maxStay;
  for (const planId of planIds.length > 0 ? planIds : []) {
    for (const run of runs(
      dates,
      (date) => {
        const night = byDate.get(date);
        return night ? restrictionOf(night) : undefined;
      },
      sameRestriction,
    )) {
      const control = `<StatusApplicationControl${attrs({ Start: run.start, End: run.end, InvTypeCode: payload.externalRoomId, RatePlanCode: planId })}/>`;
      const r = run.value;
      availMessages.push(
        `<AvailStatusMessage>${control}<RestrictionStatus${attrs({ Status: r.closed ? 'Close' : 'Open', Restriction: 'Master' })}/></AvailStatusMessage>`,
      );
      availMessages.push(
        `<AvailStatusMessage>${control}<RestrictionStatus${attrs({ Status: r.cta ? 'Close' : 'Open', Restriction: 'Arrival' })}/></AvailStatusMessage>`,
      );
      availMessages.push(
        `<AvailStatusMessage>${control}<RestrictionStatus${attrs({ Status: r.ctd ? 'Close' : 'Open', Restriction: 'Departure' })}/></AvailStatusMessage>`,
      );
      const los =
        `<LengthOfStay${attrs({ Time: r.minStay, MinMaxMessageType: 'SetMinLOS' })}/>` +
        (r.maxStay !== null
          ? `<LengthOfStay${attrs({ Time: r.maxStay, MinMaxMessageType: 'SetMaxLOS' })}/>`
          : '');
      availMessages.push(
        `<AvailStatusMessage>${control}<LengthsOfStay>${los}</LengthsOfStay></AvailStatusMessage>`,
      );
    }
  }
  const availability =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<OTA_HotelAvailNotifRQ ${NS} ${head}>` +
    `<AvailStatusMessages${attrs({ HotelCode: hotelCode })}>${availMessages.join('')}</AvailStatusMessages>` +
    `</OTA_HotelAvailNotifRQ>`;

  // --- Inventory: units left, per room type --------------------------------
  const invMessages = runs(
    dates,
    (date) => byDate.get(date)?.available,
    (a, b) => a === b,
  ).map(
    (run) =>
      `<Inventory>` +
      `<StatusApplicationControl${attrs({ Start: run.start, End: run.end, InvTypeCode: payload.externalRoomId })}/>` +
      `<InvCounts><InvCount${attrs({ CountType: 2, Count: Math.max(0, run.value) })}/></InvCounts>` +
      `</Inventory>`,
  );
  const inventory =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<OTA_HotelInvCountNotifRQ ${NS} ${head}>` +
    `<Inventories${attrs({ HotelCode: hotelCode })}>${invMessages.join('')}</Inventories>` +
    `</OTA_HotelInvCountNotifRQ>`;

  return { rates, availability, inventory };
}

/** How Google answered: the counts its response carries, or a thrown error. */
export function parseUploadResponse(body: string): {
  success: boolean;
  warnings: string[];
  errors: string[];
} {
  // `<Error ...>` but not `<Errors>`: the tag name must end at a space or the bracket.
  const errors = [...body.matchAll(/<Error(?:\s[^>]*)?>([\s\S]*?)<\/Error>/g)].map((m) =>
    m[1]!.trim(),
  );
  const warnings = [...body.matchAll(/<Warning(?:\s[^>]*)?>([\s\S]*?)<\/Warning>/g)].map((m) =>
    m[1]!.trim(),
  );
  const success = /<Success\s*\/?>/.test(body) || (errors.length === 0 && body.trim().length === 0);
  return { success, warnings, errors };
}
