import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthService } from './application/auth.service';
import { CompletePasswordResetUseCase } from './application/complete-password-reset.usecase';
import { PurgeResetTokensUseCase } from './application/purge-reset-tokens.usecase';
import { RequestPasswordResetUseCase } from './application/request-password-reset.usecase';
import { AUTH_REPOSITORY } from './domain/auth.repository';
import { PASSWORD_HASHER, ScryptPasswordHasher } from './domain/password-hasher';
import { PASSWORD_RESET_REPOSITORY } from './domain/password-reset';
import { DrizzleAuthRepository } from './infrastructure/drizzle-auth.repository';
import { DrizzlePasswordResetRepository } from './infrastructure/drizzle-password-reset.repository';
import { AuthController } from './interface/auth.controller';

@Module({
  // Secrets are passed per-call from validated config, so no global secret here.
  // NotificationsModule is imported for the EMAIL sender only: the reset link
  // is sent directly rather than through the notification log, because that log
  // is readable in the dashboard and a reset link in it is an account takeover.
  imports: [JwtModule.register({}), NotificationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    RequestPasswordResetUseCase,
    CompletePasswordResetUseCase,
    PurgeResetTokensUseCase,
    { provide: AUTH_REPOSITORY, useClass: DrizzleAuthRepository },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: PASSWORD_RESET_REPOSITORY, useClass: DrizzlePasswordResetRepository },
  ],
  // AUTH_REPOSITORY is exported as a port: user administration resets a
  // password and revokes the account's sessions, and refresh tokens are owned
  // here. Duplicating those writes in another module would give two places that
  // decide what "revoked" means. PASSWORD_RESET_REPOSITORY travels with it for
  // the same reason — an operator-driven reset must kill any link in flight.
  exports: [
    AuthService,
    PASSWORD_HASHER,
    AUTH_REPOSITORY,
    PASSWORD_RESET_REPOSITORY,
    PurgeResetTokensUseCase,
  ],
})
export class AuthModule {}
