import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type Money } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import type { AuditActor } from '../../../common/audit/audit.service';
import { CreateReservationUseCase } from '../application/create-reservation.usecase';
import { CancelReservationUseCase } from '../application/cancel-reservation.usecase';
import { GetReservationQuery } from '../application/get-reservation.query';

// Format AND calendar validity: the regex alone accepts 2026-02-30, which
// would then blow up in the domain as a 500 instead of a clean 422.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .refine(isIsoDate, 'Not a real calendar date');

const staySchema = z
  .object({
    roomTypeId: z.string().uuid(),
    ratePlanId: z.string().uuid(),
    checkIn: isoDate,
    checkOut: isoDate,
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).optional(),
    guestName: z.string().max(200).optional(),
  })
  .strict()
  // A stay must occupy at least one night. Caught here so the client gets a
  // field-level message rather than a generic domain failure.
  .refine((stay) => stay.checkOut > stay.checkIn, {
    message: 'Check-out must be after check-in',
    path: ['checkOut'],
  });

const createReservationSchema = z
  .object({
    source: z.enum(['DIRECT', 'OTA', 'WALK_IN', 'PHONE', 'EMAIL']),
    status: z.enum(['PENDING', 'CONFIRMED']).optional(),
    booker: z
      .object({
        name: z.string().min(1).max(200),
        email: z.string().max(320).optional(),
        phone: z.string().max(40).optional(),
      })
      .strict(),
    // One stay = one room unit, so a 20-room group is 20 stays.
    stays: z.array(staySchema).min(1).max(20),
    specialRequests: z.string().max(2000).optional(),
    channelId: z.string().uuid().optional(),
    guestId: z.string().uuid().optional(),
    holdTtlSeconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict();

const cancelSchema = z
  .object({
    version: z.number().int().min(0),
    reason: z.string().max(500).optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createReservationSchema>;
type CancelBody = z.infer<typeof cancelSchema>;

function presentMoney(value: Money): { amount: number; currency: string } {
  return { amount: value.amount, currency: value.currency };
}

@ApiTags('reservations')
@Controller('properties/:propertyId/reservations')
export class ReservationsController {
  constructor(
    private readonly createReservation: CreateReservationUseCase,
    private readonly cancelReservation: CancelReservationUseCase,
    private readonly getReservation: GetReservationQuery,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireCapability('reservation:create')
  @ApiOperation({ summary: 'Create a reservation' })
  async create(
    @Param('propertyId') propertyId: string,
    // The pipe goes on @Body, not @UsePipes: a method-level pipe also runs
    // against @Param, which would validate propertyId against this schema.
    @Body(new ZodValidationPipe(createReservationSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.createReservation.execute(
      {
        propertyId,
        source: body.source,
        ...(body.status ? { status: body.status } : {}),
        booker: body.booker,
        stays: body.stays.map((stay) => ({
          roomTypeId: stay.roomTypeId,
          ratePlanId: stay.ratePlanId,
          // Parsed here so an impossible date such as 2026-02-30 is rejected
          // before it reaches the domain.
          checkIn: toIsoDate(stay.checkIn),
          checkOut: toIsoDate(stay.checkOut),
          adults: stay.adults,
          ...(stay.children === undefined ? {} : { children: stay.children }),
          ...(stay.guestName === undefined ? {} : { guestName: stay.guestName }),
        })),
        ...(body.specialRequests ? { specialRequests: body.specialRequests } : {}),
        ...(body.channelId ? { channelId: body.channelId } : {}),
        ...(body.guestId ? { guestId: body.guestId } : {}),
        ...(body.holdTtlSeconds ? { holdTtlSeconds: body.holdTtlSeconds } : {}),
      },
      this.actor(request),
    );

    return {
      id: result.id,
      code: result.code,
      status: result.status,
      propertyId,
      currency: result.currency,
      subtotal: presentMoney(result.subtotal),
      serviceCharge: presentMoney(result.serviceCharge),
      tax: presentMoney(result.tax),
      total: presentMoney(result.total),
      stays: result.stays.map((stay) => ({
        id: stay.id,
        roomTypeId: stay.roomTypeId,
        ratePlanId: stay.ratePlanId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: stay.adults,
        children: stay.children,
        guestName: stay.guestName,
        subtotal: { amount: stay.subtotalMinor, currency: result.currency },
        nights: stay.nights.map((night) => ({
          date: night.date,
          amount: { amount: night.amountMinor, currency: night.currency },
        })),
      })),
    };
  }

  @Get(':id')
  @RequireCapability('reservation:read')
  @ApiOperation({ summary: 'Fetch a reservation' })
  async findOne(@Param('propertyId') propertyId: string, @Param('id') id: string) {
    const reservation = await this.getReservation.byId(id);
    // The tenant scope already limits this to the caller's organization; this
    // also stops a valid id from one property being read through another's URL.
    if (!reservation || reservation.propertyId !== propertyId) {
      throw errors.notFound('Reservation', id);
    }
    return reservation;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireCapability('reservation:cancel')
  @ApiOperation({ summary: 'Cancel a reservation and release unconsumed nights' })
  async cancel(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: CancelBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const existing = await this.getReservation.byId(id);
    if (!existing || existing.propertyId !== propertyId) {
      throw errors.notFound('Reservation', id);
    }

    const result = await this.cancelReservation.execute(
      {
        reservationId: id,
        expectedVersion: body.version,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      this.actor(request),
    );

    return {
      id: result.id,
      status: result.status,
      releasedNights: result.releasedNights,
      retainedNights: result.retainedNights,
    };
  }

  private actor(request: AuthenticatedRequest): AuditActor {
    const principal = request.principal;
    return {
      type: 'USER',
      id: principal?.id ?? null,
      label: principal?.email ?? 'unknown',
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: (request.headers['x-request-id'] as string | undefined) ?? null,
    };
  }
}
