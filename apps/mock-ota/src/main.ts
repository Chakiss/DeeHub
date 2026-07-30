import { MockOta } from './server';

/** Standalone entry point: `pnpm --filter @deehub/mock-ota dev`. */
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_OTA_PORT ?? 4001);

  const ota = new MockOta({
    apiKey: process.env.MOCK_OTA_API_KEY ?? 'mock-ota-dev-key',
    webhookSecret: process.env.MOCK_OTA_WEBHOOK_SECRET ?? 'mock-ota-webhook-secret',
    ...(process.env.MOCK_OTA_WEBHOOK_URL ? { webhookUrl: process.env.MOCK_OTA_WEBHOOK_URL } : {}),
  });

  const bound = await ota.listen(port);
  process.stdout.write(
    [
      `Mock OTA listening on http://127.0.0.1:${String(bound)}`,
      '  GET  /health',
      '  POST /api/ari          receive availability, rates and restrictions',
      '  GET  /api/ari?hotel_code=&room_id=   inspect what it received',
      '  GET  /api/bookings?since=',
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    void ota.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
