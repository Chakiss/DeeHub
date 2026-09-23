import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RoomTypesModule } from '../room-types/room-types.module';
import { AssignRoomUseCase } from './application/assign-room.usecase';
import { GetStayViewQuery } from './application/get-stay-view.query';
import { ListAssignableRoomsQuery } from './application/list-assignable-rooms.query';
import { ManageRoomsUseCase } from './application/manage-rooms.usecase';
import { ROOM_REPOSITORY } from './domain/room.repository';
import { DrizzleRoomRepository } from './infrastructure/drizzle-room.repository';
import { RoomsController } from './interface/rooms.controller';

/**
 * Physical rooms, assignment and the stay view (roadmap Phase 4).
 *
 * Exports nothing that availability could consume, on purpose: a room count
 * must never become an allotment (ADR-0002).
 */
@Module({
  // RoomTypesModule so a new room can be checked against a room type in this
  // tenant's property; InventoryModule for the shared audit-actor helper.
  imports: [RoomTypesModule, InventoryModule],
  controllers: [RoomsController],
  providers: [
    { provide: ROOM_REPOSITORY, useClass: DrizzleRoomRepository },
    ManageRoomsUseCase,
    AssignRoomUseCase,
    GetStayViewQuery,
    ListAssignableRoomsQuery,
  ],
  // ROOM_REPOSITORY so a booking can name its room at creation and have it
  // checked by the same rule the front desk's assignment uses.
  exports: [ROOM_REPOSITORY],
})
export class RoomsModule {}
