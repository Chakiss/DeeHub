import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireCapability,
  SelfScoped,
  type AuthenticatedRequest,
} from '../../../common/guards/auth.guard';
import { ListPropertiesQuery } from '../application/list-properties.query';

@ApiTags('properties')
@Controller('properties')
export class PropertiesController {
  constructor(private readonly listProperties: ListPropertiesQuery) {}

  @Get()
  @RequireCapability('property:read')
  // The query filters to the caller's memberships, so holding property:read at
  // any property is enough to ask "which properties are mine?".
  @SelfScoped()
  @ApiOperation({ summary: 'Properties the current user can act on' })
  async list(@Req() request: AuthenticatedRequest) {
    return this.listProperties.execute(request.principal?.memberships ?? []);
  }
}
