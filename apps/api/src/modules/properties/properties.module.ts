import { Module } from '@nestjs/common';
import { PROPERTY_REPOSITORY } from './domain/property.repository';
import { DrizzlePropertyRepository } from './infrastructure/drizzle-property.repository';

@Module({
  providers: [{ provide: PROPERTY_REPOSITORY, useClass: DrizzlePropertyRepository }],
  exports: [PROPERTY_REPOSITORY],
})
export class PropertiesModule {}
