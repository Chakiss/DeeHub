import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { RatesModule } from './modules/rates/rates.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { QueueModule } from './queue/queue.module';

/**
 * Root module for the background worker.
 *
 * Deliberately NOT AppModule: no controllers, no HTTP guard, no request
 * middleware. It shares the same domain and application code — the modular
 * monolith has one codebase and two entry points — but the two processes scale
 * independently (architecture.md §1). A burst of OTA sync work must never make
 * the front desk slow.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CommonModule,
    QueueModule,
    PropertiesModule,
    RatesModule,
    InventoryModule,
    ReservationsModule,
    OutboxModule,
  ],
})
export class WorkerModule {}
