import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DomainError, errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { Public } from '../../../common/guards/auth.guard';
import { DATABASE, type Database } from '../../../database/database.module';
import { SearchAvailabilityQuery } from '../../availability/application/search-availability.query';
import { CreateReservationUseCase } from '../../reservations/application/create-reservation.usecase';
import { computeBreakdown, type PriceBreakdown } from '../../reservations/domain/pricing';
import { LowestRatesQuery } from '../application/lowest-rates.query';
import { PublicBookingQuery, type PublicBooking } from '../application/public-booking.query';
import { PublicCatalogQuery } from '../application/public-catalog.query';
import {
  PublicPropertyResolver,
  type PublicProperty,
} from '../application/public-property.resolver';
import { SettlePaymentUseCase } from '../application/settle-payment.usecase';
import { StartPaymentUseCase } from '../application/start-payment.usecase';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../domain/payment-gateway';
import {
  PAYMENT_INTENT_REPOSITORY,
  type PaymentIntentRepository,
} from '../domain/payment-intent.repository';

/**
 * A hold, not a booking, until it is paid for.
 *
 * Fifteen minutes is long enough to find a card and short enough that an
 * abandoned checkout does not keep a room off sale all evening. The same
 * default the front desk's own PENDING bookings use. Starting a payment
 * extends it (start-payment.usecase).
 */
const HOLD_TTL_SECONDS = 15 * 60;

/** Enough for a family; small enough that nobody books out a hotel by accident. */
const MAX_ROOMS_PER_BOOKING = 5;

/**
 * Unpaid holds one email may have open at one property. A guest retrying a
 * checkout needs two or three; a script booking a hotel out needs dozens.
 */
const MAX_OPEN_HOLDS_PER_EMAIL = 3;

const bookingSchema = z
  .object({
    guest: z
      .object({
        name: z.string().trim().min(1).max(200),
        // Required here, unlike a desk booking: a guest booking online has no
        // other way to be told their booking exists — and it is the second
        // factor for reading the booking back.
        email: z.string().trim().min(3).max(320),
        phone: z.string().trim().max(40).optional(),
      })
      .strict(),
    stays: z
      .array(
        z
          .object({
            roomTypeId: z.string().uuid(),
            ratePlanId: z.string().uuid(),
            adults: z.number().int().min(1).max(10),
            children: z.number().int().min(0).max(10).default(0),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROOMS_PER_BOOKING),
    checkIn: z.string(),
    checkOut: z.string(),
    specialRequests: z.string().trim().max(1000).optional(),
  })
  .strict();

type BookingBody = z.infer<typeof bookingSchema>;

const paymentSchema = z
  .object({
    method: z.enum(['CARD', 'PROMPTPAY']),
    token: z.string().min(1).max(500).optional(),
    returnUri: z.string().min(8).max(2000),
  })
  .strict();

type PaymentBody = z.infer<typeof paymentSchema>;

/** The pre-payments route, kept so an older page keeps working: a card, settled in one call or not. */
const depositSchema = z
  .object({ token: z.string().min(1).max(500), returnUri: z.string().min(8).max(2000).optional() })
  .strict();

type DepositBody = z.infer<typeof depositSchema>;

/**
 * The direct booking engine (roadmap Phase 3).
 *
 * Every route is `@Public()` — that is the point of it — which makes this the
 * only controller a stranger can reach, and the one to read carefully.
 *
 * **No price comes from the request.** The caller names a room type, a rate
 * plan and dates; everything about what it costs is read server-side from the
 * same rate resolution the front desk uses. A booking engine that accepted an
 * amount would be a booking engine that sold rooms for a baht.
 *
 * **Tenancy comes from the URL**, resolved by `(organization slug, property
 * code)` — both must match — and nothing else in the request can widen it.
 *
 * **Every figure a guest sees is all-in.** The per-night prices are the
 * hotel's net rates; the `breakdown` on each plan applies service charge and
 * VAT the way the booking will, from the same function, so the number on the
 * search page, the checkout and the metasearch feed cannot disagree.
 *
 * **Rate limiting** is two layers: a cap on open holds per email here, and a
 * per-IP limit at the edge (Cloud Armor, in front of the booking site). An
 * in-memory limiter would count only its own instance's requests.
 */
/** The one public route not under a property: id → address, for Google's landing link. */
@ApiTags('booking-engine')
@Controller('public/resolve')
export class PublicResolveController {
  constructor(private readonly resolver: PublicPropertyResolver) {}

  @Public()
  @Get(':propertyId')
  @ApiOperation({
    summary: 'The booking address of a property, from the id the Hotel List Feed carries',
  })
  async resolve(@Param('propertyId') propertyId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(propertyId)) throw errors.notFound('Property', propertyId);
    const found = await this.resolver.resolveById(propertyId);
    if (!found) throw errors.notFound('Property', propertyId);
    return found;
  }
}

@ApiTags('booking-engine')
@Controller('public/:organizationSlug/:propertyCode')
export class BookingEngineController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly resolver: PublicPropertyResolver,
    private readonly catalog: PublicCatalogQuery,
    private readonly availability: SearchAvailabilityQuery,
    private readonly lowest: LowestRatesQuery,
    private readonly bookings: PublicBookingQuery,
    private readonly createReservation: CreateReservationUseCase,
    private readonly startPayment: StartPaymentUseCase,
    private readonly settlePayment: SettlePaymentUseCase,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYMENT_INTENT_REPOSITORY) private readonly intents: PaymentIntentRepository,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'The public face of one property: description, photos, rooms' })
  async property(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const catalog = await this.resolver.scoped(property, () => this.catalog.execute(property));
    if (!catalog) throw errors.notFound('Property', `${organizationSlug}/${propertyCode}`);
    return {
      ...catalog,
      paymentAvailable: this.gateway.isConfigured(),
      paymentMethods: this.gateway.methods(),
    };
  }

  @Public()
  @Get('lowest')
  @ApiOperation({ summary: 'The cheapest all-in price per night, for a calendar' })
  async lowestRates(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const [start, end] = parseStay(from, to, { maxNights: 62 });
    const nights = await this.resolver.scoped(property, () =>
      this.lowest.execute(property, start, end),
    );
    return { currency: property.currency, nights };
  }

  @Public()
  @Get('availability')
  @ApiOperation({ summary: 'What can be booked, and at what price' })
  async search(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Query('checkIn') checkIn: string,
    @Query('checkOut') checkOut: string,
    @Query('adults') adults?: string,
    @Query('children') children?: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const [from, to] = parseStay(checkIn, checkOut);

    const result = await this.resolver.scoped(property, () =>
      this.availability.execute(
        property.propertyId,
        from,
        to,
        parseCount(adults, 2, 10),
        parseCount(children, 0, 10),
        // Desk-only plans are the hotel's business, not a stranger's.
        { onlineOnly: true },
      ),
    );

    /*
     * The staff-facing search returns unbookable room types WITH a reason, so a
     * clerk can see that a three-night minimum is in the way. A guest gets only
     * what they can book: "closed to arrival" is the hotel's business, and a
     * list of things you may not have reads as a broken page.
     */
    const roomTypes = result.roomTypes
      .filter((roomType) => roomType.ratePlans.some((plan) => plan.bookable))
      .map((roomType) => {
        const ratePlans = roomType.ratePlans
          .filter((plan) => plan.bookable)
          .map((plan) => ({
            ratePlanId: plan.ratePlanId,
            name: plan.name,
            mealPlan: plan.mealPlan,
            isRefundable: plan.isRefundable,
            total: plan.total.amount,
            perNight: plan.perNight.map((night) => ({
              date: night.date,
              amount: night.amount.amount,
            })),
            breakdown: presentBreakdown(
              computeBreakdown(
                plan.perNight.map((night) => night.amount),
                property.currency,
                property,
              ),
            ),
          }));
        return {
          roomTypeId: roomType.roomTypeId,
          name: roomType.name,
          maxAdults: roomType.maxAdults,
          maxChildren: roomType.maxChildren,
          availableUnits: roomType.availableUnits,
          fromTotal: Math.min(...ratePlans.map((plan) => plan.breakdown.total)),
          ratePlans,
        };
      });

    return {
      checkIn: result.checkIn,
      checkOut: result.checkOut,
      nights: result.nights,
      currency: property.currency,
      roomTypes,
    };
  }

  @Public()
  @Post('bookings')
  @ApiOperation({ summary: 'Hold rooms for fifteen minutes while the guest pays' })
  async book(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Body(new ZodValidationPipe(bookingSchema)) body: BookingBody,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const [checkIn, checkOut] = parseStay(body.checkIn, body.checkOut);

    const result = await this.resolver.scoped(property, async () => {
      const open = await this.bookings.openHoldsFor(
        property.propertyId,
        body.guest.email,
        new Date(),
      );
      if (open >= MAX_OPEN_HOLDS_PER_EMAIL) {
        throw new DomainError(
          'RATE_LIMITED',
          'You already have bookings waiting for payment. Finish one before starting another.',
          { openHolds: open, max: MAX_OPEN_HOLDS_PER_EMAIL },
        );
      }

      return this.createReservation.execute(
        {
          propertyId: property.propertyId,
          source: 'DIRECT',
          // PENDING, holding inventory, until a payment clears or the hotel
          // says yes. A CONFIRMED booking nobody has paid for is a room given
          // away.
          status: 'PENDING',
          holdTtlSeconds: HOLD_TTL_SECONDS,
          booker: {
            name: body.guest.name,
            email: body.guest.email,
            ...(body.guest.phone ? { phone: body.guest.phone } : {}),
          },
          stays: body.stays.map((stay) => ({
            roomTypeId: stay.roomTypeId,
            ratePlanId: stay.ratePlanId,
            checkIn,
            checkOut,
            adults: stay.adults,
            children: stay.children,
          })),
          ...(body.specialRequests ? { specialRequests: body.specialRequests } : {}),
        },
        // No user did this. An audit entry naming one would be an invention.
        { type: 'SYSTEM', id: null, label: 'booking engine' },
      );
    });

    return {
      // The CODE, never the id. It is what a guest quotes on the phone, and it
      // is the only handle the payment step accepts.
      code: result.code,
      status: result.status,
      currency: result.currency,
      total: result.total.amount,
      holdExpiresInSeconds: HOLD_TTL_SECONDS,
      paymentAvailable: this.gateway.isConfigured(),
      paymentMethods: this.gateway.methods(),
    };
  }

  @Public()
  @Get('bookings/:code')
  @ApiOperation({ summary: 'A booking, to the person who made it' })
  async booking(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Param('code') code: string,
    @Query('email') email?: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const booking = await this.lookup(property, code, email);
    return presentBooking(booking);
  }

  @Public()
  @Post('bookings/:code/payments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start paying: a card, or a PromptPay QR to scan' })
  async pay(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(paymentSchema)) body: PaymentBody,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    return this.resolver.scoped(property, () =>
      this.startPayment.execute(property, {
        reservationCode: code,
        method: body.method,
        ...(body.token ? { token: body.token } : {}),
        returnUri: body.returnUri,
      }),
    );
  }

  @Public()
  @Get('bookings/:code/payments/:intentId')
  @ApiOperation({ summary: 'Whether a started payment has arrived (the page polls this)' })
  async paymentStatus(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Param('code') code: string,
    @Param('intentId') intentId: string,
    @Query('email') email?: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    return this.resolver.scoped(property, async () => {
      const booking = await this.lookup(property, code, email);
      const intent = await this.intents.findById(this.db, booking.reservationId, intentId);
      if (!intent) throw errors.notFound('Payment', intentId);
      const result = await this.settlePayment.check(intent);
      const fresh = await this.bookings.findByCodeAndEmail(property.propertyId, code, email ?? '');
      return {
        intentId: intent.id,
        method: intent.method,
        outcome: result.outcome,
        ...(result.outcome === 'FAILED' ? { reason: result.reason } : {}),
        authorizeUri: intent.authorizeUri,
        qrImageUri: intent.qrImageUri,
        expiresAt: intent.expiresAt?.toISOString() ?? null,
        reservationStatus: fresh?.status ?? booking.status,
      };
    });
  }

  @Public()
  @Post('bookings/:code/deposit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Charge a card token and confirm the booking (older clients)' })
  async deposit(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(depositSchema)) body: DepositBody,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    const result = await this.resolver.scoped(property, () =>
      this.startPayment.execute(property, {
        reservationCode: code,
        method: 'CARD',
        token: body.token,
        returnUri: body.returnUri ?? 'https://localhost/return',
      }),
    );
    // A decline answers 200 with `status: DECLINED`, like the channel test:
    // the request worked and the bank said no, which is a different thing to
    // tell a guest than "something went wrong".
    if (result.status === 'PAID') {
      return { status: 'PAID', reservationStatus: result.reservationStatus };
    }
    return result;
  }

  private async lookup(
    property: PublicProperty,
    code: string,
    email: string | undefined,
  ): Promise<PublicBooking> {
    if (!email || email.trim().length < 3) {
      throw errors.validation('email is required to read a booking');
    }
    const booking = await this.resolver.scoped(property, () =>
      this.bookings.findByCodeAndEmail(property.propertyId, code, email),
    );
    // A wrong code and a wrong email answer the same: whether the code exists
    // is not a stranger's business.
    if (!booking) throw errors.notFound('Reservation', code);
    return booking;
  }
}

function presentBreakdown(breakdown: PriceBreakdown) {
  return {
    subtotal: breakdown.subtotal.amount,
    serviceCharge: breakdown.serviceCharge.amount,
    tax: breakdown.tax.amount,
    total: breakdown.total.amount,
  };
}

function presentBooking(booking: PublicBooking) {
  return {
    code: booking.code,
    status: booking.status,
    currency: booking.currency,
    bookerName: booking.bookerName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    subtotal: booking.subtotalMinor,
    serviceCharge: booking.serviceChargeMinor,
    tax: booking.taxMinor,
    total: booking.totalMinor,
    holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
    createdAt: booking.createdAt.toISOString(),
    stays: booking.stays,
    payment: booking.payment,
  };
}

/**
 * As far ahead as inventory exists.
 *
 * 730 days is the rolling horizon the inventory job extends to (database.md
 * §5), so a date beyond it has no rows to sell and could only ever answer
 * "nothing available". Refusing it up front is a bound on the scan as much as a
 * rule: a public endpoint that accepts 2099 is one that walks two years of
 * dates for a caller who was never going to book.
 */
const MAX_LEAD_DAYS = 730;
/** Longest stay anyone books online. Bounds the response too. */
const MAX_NIGHTS = 30;

function parseStay(
  checkIn: string,
  checkOut: string,
  options: { maxNights?: number } = {},
): [IsoDate, IsoDate] {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    throw errors.validation('checkIn and checkOut must be calendar dates in YYYY-MM-DD form');
  }
  const from = toIsoDate(checkIn);
  const to = toIsoDate(checkOut);
  if (to <= from) throw errors.validation('Check-out must be after check-in');

  const maxNights = options.maxNights ?? MAX_NIGHTS;
  const nights = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (nights > maxNights) {
    throw errors.validation(`A stay cannot exceed ${String(maxNights)} nights`);
  }

  const lead = (Date.parse(from) - Date.now()) / 86_400_000;
  if (lead > MAX_LEAD_DAYS) {
    throw errors.validation('That date is too far ahead to book');
  }

  return [from, to];
}

function parseCount(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return fallback;
  return parsed;
}
