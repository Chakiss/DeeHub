import { Module } from '@nestjs/common';
import { ListAuditQuery } from './application/list-audit.query';
import { AuditController } from './interface/audit.controller';

/** Reads the trail every other module writes. Owns no tables of its own. */
@Module({
  controllers: [AuditController],
  providers: [ListAuditQuery],
  exports: [ListAuditQuery],
})
export class AuditModule {}
