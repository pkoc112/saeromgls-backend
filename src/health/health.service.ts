import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getLiveness() {
    return {
      status: 'ok',
      service: 'saeromgls-api',
      now: new Date().toISOString(),
    };
  }

  async getReadiness() {
    let dbOk = false;
    let dbError: string | null = null;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (error) {
      dbError = error instanceof Error ? error.message : 'database unavailable';
    }

    const [lastBackup, pendingRestoreRequests] = await Promise.all([
      this.prisma.backupJob.findFirst({
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          type: true,
        },
      }),
      this.prisma.restoreRequest.count({
        where: { status: { in: ['requested', 'reviewing'] } },
      }),
    ]);

    return {
      status: dbOk ? 'ok' : 'degraded',
      checks: {
        database: {
          status: dbOk ? 'ok' : 'error',
          error: dbError,
        },
        backups: {
          lastBackup,
          pendingRestoreRequests,
        },
        observability: {
          sentryConfigured: Boolean(process.env.SENTRY_DSN),
        },
      },
      now: new Date().toISOString(),
    };
  }
}
