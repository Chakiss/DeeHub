import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../database/database.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Liveness. Must not touch dependencies: if this checked the database, a
   * brief Cloud SQL blip would make Cloud Run kill and restart every healthy
   * instance, turning a small outage into a large one.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /** Readiness. Checks the dependencies required to serve traffic. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'ok'> }> {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      // Detail is deliberately omitted: probes are usually unauthenticated.
      throw new ServiceUnavailableException('Database is not reachable');
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }
}
