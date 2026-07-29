import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { OutboxService } from './outbox/outbox.service';

/**
 * Cross-cutting services every bounded context needs.
 *
 * Global because auditing and the outbox are obligations of the Definition of
 * Done, not optional collaborators a module may choose to import.
 */
@Global()
@Module({
  providers: [AuditService, OutboxService],
  exports: [AuditService, OutboxService],
})
export class CommonModule {}
