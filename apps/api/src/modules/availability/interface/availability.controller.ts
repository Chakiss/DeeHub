import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate } from '@deehub/shared';
import { RequireCapability } from '../../../common/guards/auth.guard';
import { SearchAvailabilityQuery } from '../application/search-availability.query';

@ApiTags('availability')
@Controller('properties/:propertyId/availability')
export class AvailabilityController {
  constructor(private readonly search: SearchAvailabilityQuery) {}

  @Get()
  @RequireCapability('inventory:read')
  @ApiOperation({ summary: 'Search sellable room types for a stay' })
  async find(
    @Param('propertyId') propertyId: string,
    @Query('checkIn') checkIn: string,
    @Query('checkOut') checkOut: string,
    @Query('adults') adults?: string,
    @Query('children') children?: string,
  ) {
    if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
      throw errors.validation('checkIn and checkOut must be calendar dates in YYYY-MM-DD form');
    }
    const adultCount = Number(adults ?? '2');
    const childCount = Number(children ?? '0');
    if (!Number.isInteger(adultCount) || adultCount < 1 || adultCount > 20) {
      throw errors.validation('adults must be a whole number between 1 and 20');
    }
    if (!Number.isInteger(childCount) || childCount < 0 || childCount > 20) {
      throw errors.validation('children must be a whole number between 0 and 20');
    }

    return this.search.execute(
      propertyId,
      toIsoDate(checkIn),
      toIsoDate(checkOut),
      adultCount,
      childCount,
    );
  }
}
