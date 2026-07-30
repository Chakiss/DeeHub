import { Module } from '@nestjs/common';
import { PropertiesModule } from '../properties/properties.module';
import { ListRoomTypesQuery } from './application/list-room-types.query';
import { CreateRoomTypeUseCase } from './application/create-room-type.usecase';
import { UpdateRoomTypeUseCase } from './application/update-room-type.usecase';
import { ROOM_TYPE_REPOSITORY } from './domain/room-type.repository';
import { DrizzleRoomTypeRepository } from './infrastructure/drizzle-room-type.repository';
import { RoomTypesController } from './interface/room-types.controller';

@Module({
  // PropertiesModule for PROPERTY_REPOSITORY: creating a room type has to
  // confirm the property belongs to this tenant first.
  imports: [PropertiesModule],
  controllers: [RoomTypesController],
  providers: [
    { provide: ROOM_TYPE_REPOSITORY, useClass: DrizzleRoomTypeRepository },
    ListRoomTypesQuery,
    CreateRoomTypeUseCase,
    UpdateRoomTypeUseCase,
  ],
  exports: [ROOM_TYPE_REPOSITORY, ListRoomTypesQuery],
})
export class RoomTypesModule {}
