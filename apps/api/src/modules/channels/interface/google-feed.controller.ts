import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, eq, inArray } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { timingSafeEqual } from 'node:crypto';
import { ENV, type Env } from '../../../config/env';
import { DATABASE, type Database } from '../../../database/database.module';
import { channels, properties } from '../../../database/schema';
import { Public } from '../../../common/guards/auth.guard';
import { buildHotelList } from '../infrastructure/connectors/google-hotel/hotel-list-xml';

/**
 * The Hotel List Feed Google fetches, weekly, from a URL given in Hotel
 * Center: every property with a live Google channel, across every tenant.
 *
 * Public to the JWT guard — Google has no token of ours — and guarded by an
 * unguessable key in the query string, compared in constant time. No key
 * configured means no feed at all rather than an open one. What it reveals
 * is a hotel's public address and phone, which is what the listing shows.
 *
 * Cross-tenant by design and the only such read in the system: the feed is
 * DeeHub's, not a hotel's. It reads the two tables it needs directly rather
 * than through a tenant-scoped repository, which would refuse to run here.
 */
@ApiTags('google')
@Public()
@Controller('public/google')
export class GoogleFeedController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('hotel-list.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Google Hotel List Feed: every property with a live Google channel' })
  async hotelList(@Query('key') key?: string): Promise<string> {
    const expected = this.env.GOOGLE_HOTEL_FEED_KEY;
    if (!expected || !key || !constantTimeEqual(key, expected)) {
      throw errors.notFound('Feed', 'hotel-list');
    }

    const rows = await this.db
      .select({
        id: properties.id,
        name: properties.name,
        addressLine1: properties.addressLine1,
        addressLine2: properties.addressLine2,
        city: properties.city,
        postalCode: properties.postalCode,
        country: properties.country,
        latitude: properties.latitude,
        longitude: properties.longitude,
        phone: properties.phone,
      })
      .from(properties)
      .innerJoin(
        channels,
        and(
          eq(channels.propertyId, properties.id),
          eq(channels.type, 'GOOGLE_HOTEL'),
          // ERROR is a live channel whose last push failed, not one the hotel
          // switched off; its listing must not vanish from Google over a retry.
          inArray(channels.status, ['ACTIVE', 'ERROR']),
        ),
      )
      .where(eq(properties.status, 'ACTIVE'))
      .orderBy(properties.name);

    return buildHotelList(rows);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
