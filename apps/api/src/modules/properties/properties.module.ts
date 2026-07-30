import { Module } from '@nestjs/common';
import { ListPropertiesQuery } from './application/list-properties.query';
import { PROPERTY_REPOSITORY } from './domain/property.repository';
import { DrizzlePropertyRepository } from './infrastructure/drizzle-property.repository';
import { PropertiesController } from './interface/properties.controller';

@Module({
  controllers: [PropertiesController],
  providers: [
    { provide: PROPERTY_REPOSITORY, useClass: DrizzlePropertyRepository },
    ListPropertiesQuery,
  ],
  exports: [PROPERTY_REPOSITORY, ListPropertiesQuery],
})
export class PropertiesModule {}
