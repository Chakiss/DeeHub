import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InviteUserUseCase } from './application/invite-user.usecase';
import { UpdateUserUseCase } from './application/update-user.usecase';
import { USER_REPOSITORY } from './domain/user.repository';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';
import { UsersController } from './interface/users.controller';

@Module({
  // AuthModule for PASSWORD_HASHER — an invited account needs a hash created
  // with exactly the same parameters login verifies against (ADR-0006).
  imports: [AuthModule, InventoryModule],
  controllers: [UsersController],
  providers: [
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    InviteUserUseCase,
    UpdateUserUseCase,
  ],
  exports: [USER_REPOSITORY],
})
export class UsersModule {}
