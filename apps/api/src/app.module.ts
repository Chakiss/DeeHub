import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { RatesModule } from './modules/rates/rates.module';
import { ReservationsModule } from './modules/reservations/reservations.module';

/**
 * Modular monolith root (architecture.md §1).
 *
 * Feature modules are bounded contexts. Cross-module access goes through a
 * module's exported ports or a domain event — never through another module's
 * repositories.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CommonModule,
    HealthModule,
    PropertiesModule,
    RatesModule,
    InventoryModule,
    ReservationsModule,
  ],
})
export class AppModule {}
