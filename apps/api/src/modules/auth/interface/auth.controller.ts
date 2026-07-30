import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { DomainError } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { Public, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { AuthService } from '../application/auth.service';
import { grantedCapabilities, type Membership } from '../domain/capabilities';

const REFRESH_COOKIE = 'deehub_refresh';

const loginSchema = z
  .object({
    organizationSlug: z.string().min(1).max(64),
    email: z.string().min(3).max(320),
    password: z.string().min(1).max(512),
  })
  .strict();

type LoginBody = z.infer<typeof loginSchema>;

/**
 * 12 characters minimum. Long enough to matter, short enough that a hotel's
 * front-desk staff will not write it on a sticky note — which is the actual
 * threat model here, not offline brute force against a scrypt hash.
 */
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(12, 'Use at least 12 characters').max(512),
  })
  .strict();

type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access token' })
  async login(
    // Pipe on @Body rather than @UsePipes, which would also run against
    // path params and the request object.
    @Body(new ZodValidationPipe(loginSchema)) body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login({
      organizationSlug: body.organizationSlug,
      email: body.email,
      password: body.password,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip ?? null,
    });

    this.setRefreshCookie(response, result.refreshToken);

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: this.presentUser(result.user),
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = this.readRefreshToken(request);
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Missing refresh token');

    const result = await this.auth.refresh(
      token,
      request.headers['user-agent'] ?? null,
      request.ip ?? null,
    );

    this.setRefreshCookie(response, result.refreshToken);

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: this.presentUser(result.user),
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the current refresh token' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.readRefreshToken(request));
    response.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  // Authenticated on purpose — no @Public(). Changing a password is an
  // operation on an existing session, not a way to recover a lost one.
  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change your own password and revoke all other sessions' })
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordBody,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = request.principal;
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Not authenticated');

    const tokens = await this.auth.changePassword({
      userId: principal.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip ?? null,
    });

    // The caller's old refresh token was just revoked along with every other
    // session, so it must be replaced or this response would sign them out.
    this.setRefreshCookie(response, tokens.refreshToken);

    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Get('me')
  @ApiOperation({ summary: 'Current user, memberships and capabilities' })
  me(@Req() request: AuthenticatedRequest) {
    // The guard has already authenticated, so principal is present.
    const principal = request.principal;
    if (!principal) throw new DomainError('UNAUTHENTICATED', 'Not authenticated');
    return this.presentUser(principal);
  }

  private presentUser(principal: {
    id: string;
    email: string;
    fullName: string;
    organizationId: string;
    memberships: readonly Membership[];
  }) {
    // Explicit response shape: never serialize an entity directly, or a future
    // column (a password hash, a token) leaks the day someone adds it.
    return {
      id: principal.id,
      email: principal.email,
      fullName: principal.fullName,
      organizationId: principal.organizationId,
      memberships: principal.memberships.map((membership) => ({
        role: membership.role,
        propertyId: membership.propertyId,
      })),
      // Union across all memberships: what this user can do somewhere. The
      // client uses it to decide what to render; every request is still
      // authorized per property on the server.
      capabilities: [...grantedCapabilities(principal.memberships)].sort(),
    };
  }

  private setRefreshCookie(response: Response, token: string): void {
    response.cookie(REFRESH_COOKIE, token, {
      // httpOnly: the token is never readable from client-side JavaScript, so
      // an XSS bug cannot exfiltrate a 30-day session.
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  private readRefreshToken(request: Request): string | undefined {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    const fromCookie = cookies?.[REFRESH_COOKIE];
    if (fromCookie) return fromCookie;
    // Non-browser clients (the booking engine, tests) may send it in the body.
    const body = request.body as { refreshToken?: unknown } | undefined;
    return typeof body?.refreshToken === 'string' ? body.refreshToken : undefined;
  }
}
