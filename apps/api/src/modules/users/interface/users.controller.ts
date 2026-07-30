import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { ROLES } from '../../auth/domain/capabilities';
import { InviteUserUseCase } from '../application/invite-user.usecase';
import { UpdateUserUseCase } from '../application/update-user.usecase';
import { highestRole } from '../application/user.rules';
import {
  USER_REPOSITORY,
  type OrganizationUser,
  type UserRepository,
} from '../domain/user.repository';

const inviteSchema = z
  .object({
    email: z.string().trim().min(3).max(320).email(),
    fullName: z.string().trim().min(1).max(200),
    role: z.enum(ROLES),
  })
  .strict();

const updateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    role: z.enum(ROLES).optional(),
    // No 'INVITED': that state is set by the system, never by a caller.
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();

type InviteBody = z.infer<typeof inviteSchema>;
type UpdateBody = z.infer<typeof updateSchema>;

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly invite: InviteUserUseCase,
    private readonly update: UpdateUserUseCase,
  ) {}

  @Get()
  @RequireCapability('user:read')
  @ApiOperation({ summary: 'People in this organization and their roles' })
  async getAll() {
    const rows = await this.repo.list(this.db);
    return { items: rows.map((row) => present(row)) };
  }

  @Post()
  @RequireCapability('user:invite')
  @ApiOperation({ summary: 'Create an account and return its one-time password' })
  async inviteOne(
    @Body(new ZodValidationPipe(inviteSchema)) body: InviteBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.invite.execute(
      { ...body, actorRole: highestRole(request.principal?.memberships ?? []) },
      actorFrom(request),
    );

    // The password appears here and nowhere else — not in the audit entry, not
    // in a log line. The caller must hand it over; there is no email yet.
    return { ...present(result.user), temporaryPassword: result.temporaryPassword };
  }

  // No DELETE: every audit entry and every reservation a person touched points
  // at them, so removing the row would detach that history from who did it.
  @Patch(':userId')
  @RequireCapability('user:update')
  @ApiOperation({ summary: 'Change a name, role or status; DISABLED replaces deletion' })
  async updateOne(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = request.principal;
    return present(
      await this.update.execute(
        {
          userId,
          ...body,
          actorUserId: principal?.id ?? null,
          actorRole: highestRole(principal?.memberships ?? []),
        },
        actorFrom(request),
      ),
    );
  }
}

/** Explicit shape: a password hash must never be one field away from a response. */
function present(user: OrganizationUser) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    memberships: user.memberships.map((membership) => ({
      role: membership.role,
      propertyId: membership.propertyId,
    })),
  };
}
