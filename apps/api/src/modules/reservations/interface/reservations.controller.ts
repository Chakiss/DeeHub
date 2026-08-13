import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type Money } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import type { AuditActor } from '../../../common/audit/audit.service';
import { CreateReservationUseCase } from '../application/create-reservation.usecase';
import { CancelReservationUseCase } from '../application/cancel-reservation.usecase';
import { CheckInUseCase } from '../application/check-in.usecase';
import { CheckOutUseCase } from '../application/check-out.usecase';
import { GetReservationQuery } from '../application/get-reservation.query';
import { ListReservationsQuery } from '../application/list-reservations.query';
import { ExtendStayUseCase } from '../application/extend-stay.usecase';
import { ShortenStayUseCase } from '../application/shorten-stay.usecase';
import { ModifyStayUseCase } from '../application/modify-stay.usecase';

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

/**
 * A PATCH: every field is optional and absent means "leave it alone".
 *
 * `guestName` is nullable on purpose — null clears the name, whereas absent
 * keeps it, and collapsing the two would make the name impossible to remove.
 */
const modifyStaySchema = z
  .object({
    version: z.number().int().min(0),
    roomTypeId: z.string().uuid().optional(),
    ratePlanId: z.string().uuid().optional(),
    checkIn: isoDate.optional(),
    checkOut: isoDate.optional(),
    adults: z.number().int().min(1).max(20).optional(),
    children: z.number().int().min(0).max(20).optional(),
    guestName: z.string().max(200).nullable().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
  // Only checked when BOTH are supplied; one alone is compared against the
  // stay's stored other end inside the use case.
  .refine((body) => !body.checkIn || !body.checkOut || body.checkOut > body.checkIn, {
    message: 'Check-out must be after check-in',
    path: ['checkOut'],
  });

type CreateBody = z.infer<typeof createReservationSchema>;
type CancelBody = z.infer<typeof cancelSchema>;
type ModifyStayBody = z.infer<typeof modifyStaySchema>;

/**
 * Extending takes only the new departure date.
 *
 * Nothing else about the stay may move: the moment a room type or an occupancy
 * could change, the old nights would have to be re-held and re-priced, which is
 * the modification this operation deliberately is not.
 */
const extendStaySchema = z
  .object({
    version: z.number().int().min(0),
    checkOut: isoDate,
    reason: z.string().max(500).optional(),
  })
  .strict();

type ExtendStayBody = z.infer<typeof extendStaySchema>;

/**
 * Shortening takes only the new departure date, for the same reason.
 *
 * Same shape as extending on purpose: the two are one decision at the desk —
 * "when is this guest actually leaving" — and the API should not make them
 * look like different kinds of operation.
 */
const shortenStaySchema = extendStaySchema;

type ShortenStayBody = z.infer<typeof shortenStaySchema>;

/** Optimistic locking, same as cancel: a stale tab must not act on old state. */
const versionSchema = z.object({ version: z.number().int().min(0) }).strict();

type VersionBody = z.infer<typeof versionSchema>;

/**
 * Check-out, plus the one decision the desk makes while standing there: does
 * tonight go back on sale? Absent means no, which is what every existing
 * caller already sends.
 */
const checkOutSchema = versionSchema
  .extend({ releaseRemainingNights: z.boolean().optional() })
  .strict();

type CheckOutBody = z.infer<typeof checkOutSchema>;

function presentMoney(value: Money): { amount: number; currency: string } {
  return { amount: value.amount, currency: value.currency };
}

@ApiTags('reservations')
@Controller('properties/:propertyId/reservations')
export class ReservationsController {
  constructor(
    private readonly createReservation: CreateReservationUseCase,
    private readonly cancelReservation: CancelReservationUseCase,
    private readonly checkInReservation: CheckInUseCase,
    private readonly checkOutReservation: CheckOutUseCase,
    private readonly getReservation: GetReservationQuery,
    private readonly listReservations: ListReservationsQuery,
    private readonly modifyStayUseCase: ModifyStayUseCase,
    private readonly extendStayUseCase: ExtendStayUseCase,
    private readonly shortenStayUseCase: ShortenStayUseCase,
  ) {}

  @Get()
  @RequireCapability('reservation:read')
  @ApiOperation({ summary: 'List reservations with filters and cursor pagination' })
  async list(
    @Param('propertyId') propertyId: string,
    @Query('status') status?: string,
    @Query('checkInFrom') checkInFrom?: string,
    @Query('checkInTo') checkInTo?: string,
    @Query('channelId') channelId?: string,
    @Query('source') source?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    for (const [label, value] of [
      ['checkInFrom', checkInFrom],
      ['checkInTo', checkInTo],
    ] as const) {
      if (value && !isIsoDate(value)) {
        throw errors.validation(`${label} must be a calendar date in YYYY-MM-DD form`);
      }
    }

    return this.listReservations.execute({
      propertyId,
      ...(status ? { status: status.split(',').filter(Boolean) } : {}),
      ...(checkInFrom ? { checkInFrom: toIsoDate(checkInFrom) } : {}),
      ...(checkInTo ? { checkInTo: toIsoDate(checkInTo) } : {}),
      ...(channelId ? { channelId } : {}),
      ...(source ? { source } : {}),
      ...(q ? { q } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

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

  @Patch(':id/stays/:stayId')
  @RequireCapability('reservation:modify')
  @ApiOperation({ summary: 'Change a stay: dates, room type, rate plan or occupancy' })
  async modifyStay(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Param('stayId') stayId: string,
    @Body(new ZodValidationPipe(modifyStaySchema)) body: ModifyStayBody,
    @Req() request: AuthenticatedRequest,
  ) {
    // The stay must belong to the reservation in the URL, not merely exist.
    // Without this a stay id from another booking would be modified through a
    // reservation the caller happens to be allowed to see.
    const reservation = await this.getReservation.byId(id);
    if (
      !reservation ||
      reservation.propertyId !== propertyId ||
      !reservation.stays.some((stay) => stay.id === stayId)
    ) {
      throw errors.notFound('Stay', stayId);
    }

    const result = await this.modifyStayUseCase.execute(
      {
        propertyId,
        stayId,
        expectedVersion: body.version,
        ...(body.roomTypeId ? { roomTypeId: body.roomTypeId } : {}),
        ...(body.ratePlanId ? { ratePlanId: body.ratePlanId } : {}),
        // Parsed here so an impossible date such as 2026-02-30 is rejected
        // before it reaches the domain.
        ...(body.checkIn ? { checkIn: toIsoDate(body.checkIn) } : {}),
        ...(body.checkOut ? { checkOut: toIsoDate(body.checkOut) } : {}),
        ...(body.adults === undefined ? {} : { adults: body.adults }),
        ...(body.children === undefined ? {} : { children: body.children }),
        ...(body.guestName === undefined ? {} : { guestName: body.guestName }),
        ...(body.reason ? { reason: body.reason } : {}),
      },
      this.actor(request),
    );

    return {
      reservationId: result.reservationId,
      stayId: result.stayId,
      version: result.version,
      releasedNights: result.releasedNights,
      heldNights: result.heldNights,
      // The front desk has to know: the guest no longer has a room number.
      roomAssignmentCleared: result.roomAssignmentCleared,
      total: presentMoney(result.total),
    };
  }

  @Post(':id/stays/:stayId/extend')
  @HttpCode(200)
  @RequireCapability('reservation:modify')
  @ApiOperation({ summary: 'Keep a guest longer: add nights to the end of a stay' })
  async extendStay(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Param('stayId') stayId: string,
    @Body(new ZodValidationPipe(extendStaySchema)) body: ExtendStayBody,
    @Req() request: AuthenticatedRequest,
  ) {
    // The stay must belong to the reservation in the URL, not merely exist —
    // otherwise a stay id from another booking could be extended through a
    // reservation the caller happens to be allowed to see.
    const reservation = await this.getReservation.byId(id);
    if (
      !reservation ||
      reservation.propertyId !== propertyId ||
      !reservation.stays.some((stay) => stay.id === stayId)
    ) {
      throw errors.notFound('Stay', stayId);
    }

    const result = await this.extendStayUseCase.execute(
      {
        propertyId,
        stayId,
        expectedVersion: body.version,
        // Parsed here so an impossible date such as 2026-02-30 is rejected
        // before it reaches the domain.
        checkOut: toIsoDate(body.checkOut),
        ...(body.reason ? { reason: body.reason } : {}),
      },
      this.actor(request),
    );

    return {
      reservationId: result.reservationId,
      stayId: result.stayId,
      version: result.version,
      checkOut: result.checkOut,
      addedNights: result.addedNights,
      addedAmount: presentMoney(result.addedAmount),
      total: presentMoney(result.total),
    };
  }

  @Post(':id/stays/:stayId/shorten')
  @HttpCode(200)
  @RequireCapability('reservation:modify')
  @ApiOperation({ summary: 'A guest leaves early: drop nights from the end of a stay' })
  async shortenStay(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Param('stayId') stayId: string,
    @Body(new ZodValidationPipe(shortenStaySchema)) body: ShortenStayBody,
    @Req() request: AuthenticatedRequest,
  ) {
    // Same ownership check as extending: a stay id from another booking must
    // not be reachable through a reservation the caller happens to see.
    const reservation = await this.getReservation.byId(id);
    if (
      !reservation ||
      reservation.propertyId !== propertyId ||
      !reservation.stays.some((stay) => stay.id === stayId)
    ) {
      throw errors.notFound('Stay', stayId);
    }

    const result = await this.shortenStayUseCase.execute(
      {
        propertyId,
        stayId,
        expectedVersion: body.version,
        checkOut: toIsoDate(body.checkOut),
        ...(body.reason ? { reason: body.reason } : {}),
      },
      this.actor(request),
    );

    return {
      reservationId: result.reservationId,
      stayId: result.stayId,
      version: result.version,
      checkOut: result.checkOut,
      releasedNights: result.releasedNights,
      refundedAmount: presentMoney(result.refundedAmount),
      total: presentMoney(result.total),
    };
  }

  @Post(':id/check-in')
  @HttpCode(200)
  @RequireCapability('reservation:checkin')
  @ApiOperation({ summary: 'Check a booking in; every room must be assigned first' })
  async checkIn(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(versionSchema)) body: VersionBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.checkInReservation.execute(
      { propertyId, reservationId: id, expectedVersion: body.version },
      this.actor(request),
    );
  }

  @Post(':id/check-out')
  @HttpCode(200)
  @RequireCapability('reservation:checkout')
  @ApiOperation({
    summary: 'Check a booking out, optionally returning tonight to sale',
    description:
      'releaseRemainingNights hands back the nights from today onward. The booking keeps its ' +
      'dates and the guest stays charged in full; only the room goes back on the market.',
  })
  async checkOut(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(checkOutSchema)) body: CheckOutBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.checkOutReservation.execute(
      {
        propertyId,
        reservationId: id,
        expectedVersion: body.version,
        releaseRemainingNights: body.releaseRemainingNights ?? false,
      },
      this.actor(request),
    );
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
