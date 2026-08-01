import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { RequireCapability } from '../../../common/guards/auth.guard';
import { GetPerformanceQuery } from '../application/get-performance.query';
import { GetPickupQuery } from '../application/get-pickup.query';

/** A year at a time: enough for year-to-date, bounded for the response. */
const MAX_RANGE_DAYS = 400;

@ApiTags('reports')
@Controller('properties/:propertyId/reports')
export class ReportsController {
  constructor(
    private readonly performance: GetPerformanceQuery,
    private readonly pickup: GetPickupQuery,
  ) {}

  /**
   * Guarded by `reservation:read` rather than a report-specific capability.
   * Every figure here is derived from reservations that someone with that
   * capability can already read one by one; a separate permission would imply a
   * confidentiality boundary that does not exist.
   */
  @Get('performance')
  @RequireCapability('reservation:read')
  @ApiOperation({ summary: 'Rooms sold, revenue, ADR, RevPAR and occupancy by night' })
  async getPerformance(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.performance.execute(propertyId, ...this.parseRange(from, to));
  }

  /**
   * Pickup over a stay window, compared against a past business date.
   *
   * `asOf` is the baseline, not a filter: it names the day whose on-the-books
   * figures the current ones are measured against. Absent, it is a week ago,
   * which is the question a hotelier actually asks on a Monday morning.
   */
  @Get('pickup')
  @RequireCapability('reservation:read')
  @ApiOperation({ summary: 'Business taken for each stay date since a past date' })
  async getPickup(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('asOf') asOf?: string,
  ) {
    const [start, end] = this.parseRange(from, to);
    return this.pickup.execute(propertyId, start, end, this.parseAsOf(asOf));
  }

  private parseAsOf(asOf: string | undefined): IsoDate {
    if (asOf === undefined || asOf === '') {
      const week = new Date(Date.now() - 7 * 86_400_000);
      return toIsoDate(week.toISOString().slice(0, 10));
    }
    if (!isIsoDate(asOf)) {
      throw errors.validation('asOf must be a calendar date in YYYY-MM-DD form');
    }
    return toIsoDate(asOf);
  }

  private parseRange(from: string, to: string): [IsoDate, IsoDate] {
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw errors.validation('from and to must be calendar dates in YYYY-MM-DD form');
    }
    const start = toIsoDate(from);
    const end = toIsoDate(to);
    if (end <= start) throw errors.validation('Range end must be after start');

    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      throw errors.validation(`Range cannot exceed ${String(MAX_RANGE_DAYS)} nights`);
    }
    return [start, end];
  }
}
