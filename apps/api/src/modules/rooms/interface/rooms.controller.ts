import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors, isIsoDate, toIsoDate, type IsoDate } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { AssignRoomUseCase } from '../application/assign-room.usecase';
import { GetStayViewQuery } from '../application/get-stay-view.query';
import { ManageRoomsUseCase } from '../application/manage-rooms.usecase';
import {
  HOUSEKEEPING_STATUSES,
  ROOM_REPOSITORY,
  type RoomRecord,
  type RoomRepository,
} from '../domain/room.repository';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .refine(isIsoDate, 'Not a real calendar date');

const createSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    roomNumber: z.string().trim().min(1).max(32),
    floor: z.string().trim().max(32).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

// roomTypeId is absent: moving a room between types would rewrite what every
// past assignment meant.
const updateSchema = z
  .object({
    roomNumber: z.string().trim().min(1).max(32).optional(),
    floor: z.string().trim().max(32).nullable().optional(),
    housekeepingStatus: z.enum(HOUSEKEEPING_STATUSES).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const assignSchema = z
  .object({
    // null releases the room rather than assigning another.
    roomId: z.string().uuid().nullable(),
  })
  .strict();

type CreateBody = z.infer<typeof createSchema>;
type UpdateBody = z.infer<typeof updateSchema>;
type AssignBody = z.infer<typeof assignSchema>;

/** A month at a time; the grid is read a fortnight ahead in practice. */
const MAX_RANGE_DAYS = 62;

@ApiTags('rooms')
@Controller('properties/:propertyId')
export class RoomsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ROOM_REPOSITORY) private readonly repo: RoomRepository,
    private readonly manage: ManageRoomsUseCase,
    private readonly assign: AssignRoomUseCase,
    private readonly stayView: GetStayViewQuery,
  ) {}

  @Get('rooms')
  @RequireCapability('room:read')
  @ApiOperation({ summary: 'Physical rooms, by floor then number' })
  async getRooms(@Param('propertyId') propertyId: string) {
    const rows = await this.repo.list(this.db, propertyId);
    return { items: rows.map((row) => present(row)) };
  }

  @Post('rooms')
  @RequireCapability('room:create')
  @ApiOperation({ summary: 'Add a physical room' })
  async createRoom(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(createSchema)) body: CreateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(await this.manage.create({ propertyId, ...body }, actorFrom(request)));
  }

  // No DELETE: past assignments point at the room. isActive: false takes it out
  // of service and keeps the history.
  @Patch('rooms/:roomId')
  @RequireCapability('room:update')
  @ApiOperation({ summary: 'Update a room or its housekeeping status' })
  async updateRoom(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return present(
      await this.manage.update({ propertyId, roomId, fields: body }, actorFrom(request)),
    );
  }

  /**
   * Assignment is front-desk work, so it rides on `reservation:update` rather
   * than `room:update` — housekeeping may set a room dirty without being able
   * to move guests around.
   */
  @Patch('stays/:stayId/room')
  @RequireCapability('reservation:update')
  @ApiOperation({ summary: 'Assign a stay to a room, or release it with null' })
  async assignRoom(
    @Param('propertyId') propertyId: string,
    @Param('stayId') stayId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.assign.execute({ propertyId, stayId, roomId: body.roomId }, actorFrom(request));
  }

  @Get('stay-view')
  @RequireCapability('reservation:read')
  @ApiOperation({ summary: 'Who is in which room, plus what still needs a room' })
  async getStayView(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.stayView.execute(propertyId, ...this.parseRange(from, to));
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

function present(room: RoomRecord) {
  return {
    id: room.id,
    roomTypeId: room.roomTypeId,
    roomNumber: room.roomNumber,
    floor: room.floor,
    housekeepingStatus: room.housekeepingStatus,
    notes: room.notes,
    isActive: room.isActive,
  };
}
