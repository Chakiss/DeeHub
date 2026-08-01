import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import type { AuditActor } from '../../../common/audit/audit.service';
import { CHANNEL_TYPES } from '../domain/channel-connector';
import { ListChannelsQuery } from '../application/list-channels.query';
import { ManageChannelUseCase } from '../application/manage-channel.usecase';
import { ForceSyncUseCase } from '../application/force-sync.usecase';
import { TestChannelConnectionUseCase } from '../application/test-channel-connection.usecase';

/**
 * Free-form because every OTA names its secrets differently — Booking.com wants
 * a hotel id and a password, Agoda an API key. Values are strings only, so a
 * nested object cannot smuggle something the cipher would serialise oddly.
 */
const credentialsSchema = z.record(z.string().min(1).max(200), z.string().max(4000));

const createChannelSchema = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    name: z.string().min(1).max(120),
    syncHorizonDays: z.number().int().min(1).max(730).optional(),
    credentials: credentialsSchema.optional(),
  })
  .strict();

const updateChannelSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    syncHorizonDays: z.number().int().min(1).max(730).optional(),
    // ERROR is deliberately not settable: it is set by the sync engine when a
    // push fails, and letting an operator declare it would lie about health.
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    credentials: credentialsSchema.optional(),
  })
  .strict();

const mappingSchema = z
  .object({
    localId: z.string().uuid(),
    externalId: z.string().min(1).max(200),
    externalName: z.string().max(200).nullable().optional(),
  })
  .strict();

const replaceMappingsSchema = z
  .object({
    roomTypes: z.array(mappingSchema).max(200),
    ratePlans: z.array(mappingSchema).max(500),
  })
  .strict();

type CreateBody = z.infer<typeof createChannelSchema>;
type UpdateBody = z.infer<typeof updateChannelSchema>;
type MappingsBody = z.infer<typeof replaceMappingsSchema>;

@ApiTags('channels')
@Controller('properties/:propertyId/channels')
export class ChannelsController {
  constructor(
    private readonly channels: ListChannelsQuery,
    private readonly manage: ManageChannelUseCase,
    private readonly testConnection: TestChannelConnectionUseCase,
    private readonly forceSync: ForceSyncUseCase,
  ) {}

  @Get()
  @RequireCapability('channel:read')
  @ApiOperation({ summary: 'List channels with their sync health' })
  async list(@Param('propertyId') propertyId: string) {
    return { items: await this.channels.list(propertyId) };
  }

  @Get(':channelId')
  @RequireCapability('channel:read')
  @ApiOperation({ summary: 'One channel: mappings, recent syncs and inbound bookings' })
  async findOne(@Param('propertyId') propertyId: string, @Param('channelId') channelId: string) {
    const channel = await this.channels.byId(propertyId, channelId);
    if (!channel) throw errors.notFound('Channel', channelId);
    return channel;
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('channel:create')
  @ApiOperation({ summary: 'Create a channel; it starts inactive until mapped' })
  async create(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(createChannelSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.manage.create(
      {
        propertyId,
        type: body.type,
        name: body.name,
        ...(body.syncHorizonDays ? { syncHorizonDays: body.syncHorizonDays } : {}),
        ...(body.credentials ? { credentials: body.credentials } : {}),
      },
      this.actor(request),
    );
  }

  @Patch(':channelId')
  @RequireCapability('channel:update')
  @ApiOperation({ summary: 'Rename, re-credential, or activate/deactivate a channel' })
  async update(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.manage.update(
      {
        propertyId,
        channelId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.syncHorizonDays === undefined ? {} : { syncHorizonDays: body.syncHorizonDays }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.credentials ? { credentials: body.credentials } : {}),
      },
      this.actor(request),
    );

    // Re-read rather than echo the input: activation can be refused, and the
    // caller needs the mapping counts anyway.
    return this.channels.byId(propertyId, channelId);
  }

  @Put(':channelId/mappings')
  @RequireCapability('channel:update')
  @ApiOperation({ summary: 'Replace every room type and rate plan mapping' })
  async replaceMappings(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Body(new ZodValidationPipe(replaceMappingsSchema)) body: MappingsBody,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.manage.replaceMappings(
      { propertyId, channelId, roomTypes: body.roomTypes, ratePlans: body.ratePlans },
      this.actor(request),
    );
    return this.channels.byId(propertyId, channelId);
  }

  /**
   * `channel:sync` rather than `channel:read`.
   *
   * It looks like a read — nothing in DeeHub changes — but it opens an
   * authenticated connection to a third party using the hotel's credentials,
   * and rate limits at the other end are real. That belongs to whoever is
   * allowed to talk to the channel at all.
   */
  @Post(':channelId/test-connection')
  @HttpCode(200)
  @RequireCapability('channel:sync')
  @ApiOperation({ summary: 'Ask the channel whether the credentials work' })
  async test(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    // A failed test is a 200: the request worked, the credential did not, and
    // an HTTP error would show a network problem where there is a config one.
    return this.testConnection.execute({ propertyId, channelId }, this.actor(request));
  }

  @Post(':channelId/sync')
  @HttpCode(200)
  @RequireCapability('channel:sync')
  @ApiOperation({ summary: 'Push the whole horizon to this channel now' })
  async sync(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.forceSync.execute({ propertyId, channelId }, this.actor(request));
  }

  private actor(request: AuthenticatedRequest): AuditActor {
    const principal = request.principal;
    return {
      type: 'USER',
      id: principal?.id ?? null,
      label: principal?.email ?? 'unknown',
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: (request.headers['x-request-id'] as string | undefined) ?? null,
    };
  }
}
