import { Module } from '@nestjs/common';
import { QueueModule } from '../../queue/queue.module';
import { OutboxRelayService } from './outbox-relay.service';

/**
 * The relay is worker-only: it is imported by WorkerModule and NOT by
 * AppModule. Running it in the HTTP process would make request latency
 * compete with sync work, which is exactly the split architecture.md §1
 * describes.
 */
@Module({
  imports: [QueueModule],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
