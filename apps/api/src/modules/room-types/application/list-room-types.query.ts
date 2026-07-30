import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  ROOM_TYPE_REPOSITORY,
  type RoomTypeRecord,
  type RoomTypeRepository,
} from '../domain/room-type.repository';

@Injectable()
export class ListRoomTypesQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_TYPE_REPOSITORY) private readonly repo: RoomTypeRepository,
  ) {}

  /**
   * Inactive types are included by default.
   *
   * They still hold inventory, rates and past reservations, so hiding them
   * would make a room type a hotel deactivated look deleted — and leave nobody
   * a way to turn it back on.
   */
  execute(propertyId: string): Promise<readonly RoomTypeRecord[]> {
    return this.repo.list(this.db, propertyId);
  }
}
