import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { Public } from '../../../common/guards/auth.guard';
import { SearchAvailabilityQuery } from '../../availability/application/search-availability.query';
import { CreateReservationUseCase } from '../../reservations/application/create-reservation.usecase';
import {
  PublicPropertyResolver,
  type PublicProperty,
} from '../application/public-property.resolver';
import { TakeDepositUseCase } from '../application/take-deposit.usecase';
import { PAYMENT_GATEWAY } from '../domain/payment-gateway';
import { Inject } from '@nestjs/common';
import type { PaymentGateway } from '../domain/payment-gateway';

/**
 * A hold, not a booking, until it is paid for.
 *
 * Fifteen minutes is long enough to find a card and short enough that an
 * abandoned checkout does not keep a room off sale all evening. The same
 * default the front desk's own PENDING bookings use.
 */
const HOLD_TTL_SECONDS = 15 * 60;

/** Enough for a family; small enough that nobody books out a hotel by accident. */
const MAX_ROOMS_PER_BOOKING = 5;

const bookingSchema = z
  .object({
    guest: z
      .object({
        name: z.string().trim().min(1).max(200),
        // Required here, unlike a desk booking: a guest booking online has no
        // other way to be told their booking exists.
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

const depositSchema = z.object({ token: z.string().min(1).max(500) }).strict();

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
 * **There is no rate limiting here yet**, and that is a real gap rather than an
 * oversight: an in-memory limiter is useless behind a Cloud Run service that
 * scales horizontally, and doing it properly needs either Redis or Cloud
 * Armor. Until then the exposure is a stranger creating expiring holds. Holds
 * expire on their own and the maintenance job releases them, so the damage is
 * bounded and self-healing, but a determined caller could keep a small hotel's
 * inventory occupied. Recorded in decisions-pending-review.
 */
@ApiTags('booking-engine')
@Controller('public/:organizationSlug/:propertyCode')
export class BookingEngineController {
  constructor(
    private readonly resolver: PublicPropertyResolver,
    private readonly availability: SearchAvailabilityQuery,
    private readonly createReservation: CreateReservationUseCase,
    private readonly takeDeposit: TakeDepositUseCase,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'The public face of one property' })
  async property(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);
    return present(property, this.gateway.isConfigured());
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
      ),
    );

    /*
     * The staff-facing search returns unbookable room types WITH a reason, so a
     * clerk can see that a three-night minimum is in the way. A guest gets only
     * what they can book: "closed to arrival" is the hotel's business, and a
     * list of things you may not have reads as a broken page.
     */
    return {
      checkIn: result.checkIn,
      checkOut: result.checkOut,
      nights: result.nights,
      currency: property.currency,
      roomTypes: result.roomTypes
        .filter((roomType) => roomType.ratePlans.some((plan) => plan.bookable))
        .map((roomType) => ({
          roomTypeId: roomType.roomTypeId,
          name: roomType.name,
          availableUnits: roomType.availableUnits,
          ratePlans: roomType.ratePlans
            .filter((plan) => plan.bookable)
            .map((plan) => ({
              ratePlanId: plan.ratePlanId,
              name: plan.name,
              total: plan.total.amount,
              perNight: plan.perNight.map((night) => ({
                date: night.date,
                amount: night.amount.amount,
              })),
            })),
        })),
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

    const result = await this.resolver.scoped(property, () =>
      this.createReservation.execute(
        {
          propertyId: property.propertyId,
          source: 'DIRECT',
          // PENDING, holding inventory, until a card clears or the hotel says
          // yes. A CONFIRMED booking nobody has paid for is a room given away.
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
      ),
    );

    return {
      // The CODE, never the id. It is what a guest quotes on the phone, and it
      // is the only handle the payment step accepts.
      code: result.code,
      status: result.status,
      currency: result.currency,
      total: result.total.amount,
      holdExpiresInSeconds: HOLD_TTL_SECONDS,
      paymentAvailable: this.gateway.isConfigured(),
    };
  }

  @Public()
  @Post('bookings/:code/deposit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Charge the card and confirm the booking' })
  async deposit(
    @Param('organizationSlug') organizationSlug: string,
    @Param('propertyCode') propertyCode: string,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(depositSchema)) body: DepositBody,
  ) {
    const property = await this.resolver.resolve(organizationSlug, propertyCode);

    // A decline answers 200 with `status: DECLINED`, like the channel test:
    // the request worked and the bank said no, which is a different thing to
    // tell a guest than "something went wrong".
    return this.resolver.scoped(property, () =>
      this.takeDeposit.execute(property, { reservationCode: code, token: body.token }),
    );
  }
}

function present(property: PublicProperty, paymentAvailable: boolean) {
  // Explicit and small. A stranger sees a hotel's name and its times, and a
  // column added to `properties` later does not become public by default.
  return {
    name: property.name,
    currency: property.currency,
    timezone: property.timezone,
    country: property.country,
    phone: property.phone,
    checkInTime: property.checkInTime,
    checkOutTime: property.checkOutTime,
    paymentAvailable,
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

function parseStay(checkIn: string, checkOut: string): [IsoDate, IsoDate] {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    throw errors.validation('checkIn and checkOut must be calendar dates in YYYY-MM-DD form');
  }
  const from = toIsoDate(checkIn);
  const to = toIsoDate(checkOut);
  if (to <= from) throw errors.validation('Check-out must be after check-in');

  const nights = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (nights > MAX_NIGHTS) {
    throw errors.validation(`A stay cannot exceed ${String(MAX_NIGHTS)} nights`);
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
