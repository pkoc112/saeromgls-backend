import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WorkersModule } from './workers/workers.module';
import { ClassificationsModule } from './classifications/classifications.module';
import { WorkItemsModule } from './work-items/work-items.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AiModule } from './ai/ai.module';
import { SitesModule } from './sites/sites.module';
import { BreakConfigsModule } from './break-configs/break-configs.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

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
    SitesModule,
    BreakConfigsModule,
    SubscriptionsModule,
  ],
})
export class AppModule {}
