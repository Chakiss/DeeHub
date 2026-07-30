import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../../common/guards/auth.guard';
import { ReceiveWebhookUseCase } from '../application/receive-webhook.usecase';

/**
 * Inbound OTA webhooks (api-spec.md §6.9).
 *
 * Public to the JWT guard, authenticated instead by a per-channel HMAC
 * signature over the raw body — an OTA has no bearer token of ours.
 */
@ApiTags('webhooks')
@Public()
@Controller('webhooks/channels')
export class WebhooksController {
  constructor(private readonly receiveWebhook: ReceiveWebhookUseCase) {}

  @Post(':channelId')
  @HttpCode(202)
  @ApiOperation({ summary: 'Receive a booking notification from a channel' })
  async receive(
    @Param('channelId') channelId: string,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-mock-signature') signature?: string,
  ) {
    // The RAW bytes, captured by the body-parser verify hook in main.ts.
    // Re-serializing the parsed object would change key order and whitespace,
    // and the signature would never match.
    const rawBody = request.rawBody?.toString('utf8') ?? JSON.stringify(request.body ?? {});

    const result = await this.receiveWebhook.execute({ channelId, rawBody, signature });

    // 202, not 201: the booking is stored, not yet mapped. Returning only after
    // mapping would keep the OTA waiting and provoke a retry.
    return {
      accepted: result.received,
      duplicates: result.duplicates,
      quarantined: result.quarantined,
    };
  }
}
