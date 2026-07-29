import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './application/auth.service';
import { AUTH_REPOSITORY } from './domain/auth.repository';
import { PASSWORD_HASHER, ScryptPasswordHasher } from './domain/password-hasher';
import { DrizzleAuthRepository } from './infrastructure/drizzle-auth.repository';
import { AuthController } from './interface/auth.controller';

@Module({
  // Secrets are passed per-call from validated config, so no global secret here.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: AUTH_REPOSITORY, useClass: DrizzleAuthRepository },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
  ],
  exports: [AuthService, PASSWORD_HASHER],
})
export class AuthModule {}
