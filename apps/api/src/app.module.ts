import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Modular monolith root (architecture.md §1).
 *
 * Feature modules are added here as bounded contexts land. Cross-module
 * imports go through a module's public surface or a domain event — never
 * through another module's repositories.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule],
})
export class AppModule {}
