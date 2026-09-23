import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import {
  RequireCapability,
  SelfScoped,
  type AuthenticatedRequest,
} from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { ListPropertiesQuery } from '../application/list-properties.query';
import { UpdatePropertyUseCase } from '../application/update-property.usecase';
import {
  PROPERTY_REPOSITORY,
  type PropertyProfile,
  type PropertyRepository,
} from '../domain/property.repository';

const text = (max: number) => z.string().trim().max(max).nullable().optional();
/** "14:00" — Postgres `time`, no seconds so the form and the column agree. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    addressLine1: text(200),
    addressLine2: text(200),
    city: text(120),
    postalCode: text(20),
    phone: text(40),
    email: z.string().trim().email().max(320).nullable().optional(),
    website: z.string().trim().url().max(500).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    descriptionTh: text(4000),
    descriptionEn: text(4000),
    amenities: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
    checkInTime: clock.optional(),
    checkOutTime: clock.optional(),
  })
  .strict();

type UpdateBody = z.infer<typeof updateSchema>;

@ApiTags('properties')
@Controller('properties')
export class PropertiesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROPERTY_REPOSITORY) private readonly repo: PropertyRepository,
    private readonly listProperties: ListPropertiesQuery,
    private readonly update: UpdatePropertyUseCase,
  ) {}

  @Get()
  @RequireCapability('property:read')
  // The query filters to the caller's memberships, so holding property:read at
  // any property is enough to ask "which properties are mine?".
  @SelfScoped()
  @ApiOperation({ summary: 'Properties the current user can act on' })
  async list(@Req() request: AuthenticatedRequest) {
    return this.listProperties.execute(request.principal?.memberships ?? []);
  }

  @Get(':propertyId')
  @RequireCapability('property:read')
  @ApiOperation({ summary: 'One property, as the settings page and the booking page see it' })
  async get(@Param('propertyId') propertyId: string) {
    const profile = await this.repo.findProfile(this.db, propertyId);
    if (!profile) throw errors.notFound('Property', propertyId);
    return present(profile);
  }

  @Patch(':propertyId')
  @RequireCapability('property:update')
  @ApiOperation({ summary: 'Edit address, contact, description, coordinates and check-in times' })
  async patch(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.update.execute(
        {
          propertyId,
          fields: {
            ...body,
            // Empty strings arrive from cleared inputs; they mean "none".
            ...(body.website === '' ? { website: null } : {}),
            ...(body.email === '' ? { email: null } : {}),
          },
        },
        actorFrom(request),
      ),
    );
  }
}

function present(profile: PropertyProfile) {
  return {
    id: profile.id,
    code: profile.code,
    name: profile.name,
    timezone: profile.timezone,
    currency: profile.currency,
    country: profile.country,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    postalCode: profile.postalCode,
    phone: profile.phone,
    email: profile.email,
    website: profile.website,
    latitude: profile.latitude,
    longitude: profile.longitude,
    descriptionTh: profile.descriptionTh,
    descriptionEn: profile.descriptionEn,
    amenities: profile.amenities,
    checkInTime: profile.checkInTime,
    checkOutTime: profile.checkOutTime,
    taxRateBp: profile.taxRateBp,
    serviceChargeRateBp: profile.serviceChargeRateBp,
    pricesIncludeTax: profile.pricesIncludeTax,
    status: profile.status,
  };
}
