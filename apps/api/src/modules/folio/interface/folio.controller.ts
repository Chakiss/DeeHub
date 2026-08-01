import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { FOLIO_CHARGE_KINDS, FOLIO_PAYMENT_METHODS } from '../domain/folio';
import { GetFolioQuery, type Folio } from '../application/get-folio.query';
import { PostChargeUseCase } from '../application/post-charge.usecase';
import { RecordPaymentUseCase } from '../application/record-payment.usecase';
import { VoidFolioLineUseCase } from '../application/void-folio-line.usecase';

/**
 * Integer minor units, like every other amount in the system (ADR-0003).
 *
 * Capped well above any plausible single line. The ceiling is not a business
 * rule — it is that a fat-fingered extra zero on a damage charge should be
 * refused by validation rather than discovered on a guest's card statement.
 */
const amountMinor = z.number().int().positive().max(100_000_000);

const chargeSchema = z
  .object({
    kind: z.enum(FOLIO_CHARGE_KINDS),
    description: z.string().trim().max(500).optional(),
    amount: amountMinor,
    // Almost everything a hotel sells is taxable; the exceptions are the lines
    // that are not sales at all.
    taxable: z.boolean().default(true),
  })
  .strict();

type ChargeBody = z.infer<typeof chargeSchema>;

const paymentSchema = z
  .object({
    kind: z.enum(['PAYMENT', 'REFUND']).default('PAYMENT'),
    method: z.enum(FOLIO_PAYMENT_METHODS),
    amount: amountMinor,
    reference: z.string().trim().max(200).optional(),
  })
  .strict();

type PaymentBody = z.infer<typeof paymentSchema>;

/** A void with no reason is indistinguishable from a mistake. */
const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

type VoidBody = z.infer<typeof voidSchema>;

@ApiTags('folio')
@Controller('properties/:propertyId/reservations/:reservationId/folio')
export class FolioController {
  constructor(
    private readonly folio: GetFolioQuery,
    private readonly postCharge: PostChargeUseCase,
    private readonly recordPayment: RecordPaymentUseCase,
    private readonly voidLine: VoidFolioLineUseCase,
  ) {}

  @Get()
  @RequireCapability('folio:read')
  @ApiOperation({ summary: "The guest's account: charges, payments and balance" })
  async get(
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
  ) {
    return present(await this.folio.execute(propertyId, reservationId));
  }

  @Post('charges')
  @RequireCapability('folio:post')
  @ApiOperation({ summary: 'Put something on the bill that is not a room night' })
  async charge(
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(chargeSchema)) body: ChargeBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.postCharge.execute(
        {
          propertyId,
          reservationId,
          kind: body.kind,
          description: body.description ?? null,
          amountMinor: body.amount,
          taxable: body.taxable,
        },
        actorFrom(request),
      ),
    );
  }

  @Post('payments')
  @RequireCapability('folio:post')
  @ApiOperation({ summary: 'Record money taken, or given back' })
  async payment(
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(paymentSchema)) body: PaymentBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.recordPayment.execute(
        {
          propertyId,
          reservationId,
          kind: body.kind,
          method: body.method,
          amountMinor: body.amount,
          reference: body.reference ?? null,
        },
        actorFrom(request),
      ),
    );
  }

  /*
   * POST rather than DELETE, on both of these.
   *
   * Nothing is removed — the line stays, marked void, with who and why — so
   * DELETE would describe an operation this does not perform, and would have
   * nowhere to carry the reason.
   */
  @Post('charges/:lineId/void')
  @HttpCode(200)
  @RequireCapability('folio:void')
  @ApiOperation({ summary: 'Reverse a charge, keeping the record of it' })
  async voidCharge(
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(voidSchema)) body: VoidBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.voidLine.execute(
        { propertyId, reservationId, lineId, kind: 'CHARGE', reason: body.reason },
        actorFrom(request),
      ),
    );
  }

  @Post('payments/:lineId/void')
  @HttpCode(200)
  @RequireCapability('folio:void')
  @ApiOperation({ summary: 'Reverse a payment, keeping the record of it' })
  async voidPayment(
    @Param('propertyId') propertyId: string,
    @Param('reservationId') reservationId: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(voidSchema)) body: VoidBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.voidLine.execute(
        { propertyId, reservationId, lineId, kind: 'PAYMENT', reason: body.reason },
        actorFrom(request),
      ),
    );
  }
}

/** Explicit shape: never serialize a row, or a future column leaks with it. */
function present(folio: Folio) {
  return {
    reservationId: folio.reservationId,
    code: folio.code,
    status: folio.status,
    bookerName: folio.bookerName,
    currency: folio.currency,
    roomCharges: folio.roomCharges.map((line) => ({
      date: line.date,
      stayId: line.stayId,
      roomTypeName: line.roomTypeName,
      amount: line.amountMinor,
    })),
    extraCharges: folio.extraCharges.map((line) => ({
      id: line.id,
      kind: line.kind,
      description: line.description,
      amount: line.amountMinor,
      taxable: line.taxable,
      businessDate: line.businessDate,
      postedAt: line.postedAt.toISOString(),
      postedBy: line.postedBy,
      voidedAt: line.voidedAt?.toISOString() ?? null,
      voidedReason: line.voidedReason,
    })),
    payments: folio.payments.map((line) => ({
      id: line.id,
      kind: line.kind,
      method: line.method,
      amount: line.amountMinor,
      reference: line.reference,
      businessDate: line.businessDate,
      recordedAt: line.recordedAt.toISOString(),
      recordedBy: line.recordedBy,
      voidedAt: line.voidedAt?.toISOString() ?? null,
      voidedReason: line.voidedReason,
    })),
    totals: {
      roomSubtotal: folio.totals.roomSubtotal.amount,
      extrasSubtotal: folio.totals.extrasSubtotal.amount,
      serviceCharge: folio.totals.serviceCharge.amount,
      tax: folio.totals.tax.amount,
      untaxedExtras: folio.totals.untaxedExtras.amount,
      chargesTotal: folio.totals.chargesTotal.amount,
      paid: folio.totals.paid.amount,
      refunded: folio.totals.refunded.amount,
      balance: folio.totals.balance.amount,
    },
  };
}
