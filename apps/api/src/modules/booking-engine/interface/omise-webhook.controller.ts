import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/guards/auth.guard';
import { SettlePaymentUseCase } from '../application/settle-payment.usecase';

interface OmiseEvent {
  object?: string;
  key?: string;
  data?: { object?: string; id?: string };
}

/**
 * Omise tells us a charge changed.
 *
 * Public to the JWT guard — Omise has no token of ours — and NOT trusted:
 * Omise signs nothing, so the body is treated as a hint naming a charge, and
 * the use case goes and asks Omise what actually happened over the
 * authenticated API. A forged body therefore achieves nothing but a GET.
 *
 * Always 200. Anything else makes Omise retry, and an event we do not
 * recognise will not become one we do by being delivered again.
 */
@ApiTags('webhooks')
@Public()
@Controller('webhooks/omise')
export class OmiseWebhookController {
  constructor(private readonly settle: SettlePaymentUseCase) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive a charge event from Omise' })
  async receive(@Body() body: OmiseEvent) {
    const chargeId = body?.data?.object === 'charge' ? body.data.id : undefined;
    if (
      typeof chargeId === 'string' &&
      chargeId.startsWith('chrg_') &&
      body.key?.startsWith('charge.')
    ) {
      await this.settle.checkByProviderCharge(chargeId);
      return { received: true };
    }
    return { received: false };
  }
}
