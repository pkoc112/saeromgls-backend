import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WorkersModule } from './workers/workers.module';
import { ClassificationsModule } from './classifications/classifications.module';
import { WorkItemsModule } from './work-items/work-items.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    WorkersModule,
    ClassificationsModule,
    WorkItemsModule,
    AuditLogsModule,
    DashboardModule,
    AiModule,
  ],
})
export class AppModule {}
