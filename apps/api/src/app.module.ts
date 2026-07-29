import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { AuthGuard } from './common/guards/auth.guard';
import { RequestScopeMiddleware } from './common/tenant/request-scope.middleware';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
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
    AuthModule,
    HealthModule,
    PropertiesModule,
    RatesModule,
    InventoryModule,
    ReservationsModule,
  ],
  providers: [
    // Authentication is the DEFAULT. A new controller is protected the moment
    // it is written; opting out requires an explicit @Public(), which shows up
    // in review. The opposite default eventually ships an open endpoint.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before guards: it opens the AsyncLocalStorage scope that the
    // auth guard populates and every repository reads.
    consumer.apply(RequestScopeMiddleware).forRoutes('*path');
  }
}
