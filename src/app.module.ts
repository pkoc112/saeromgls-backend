import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { PerformanceModule } from './performance/performance.module';
import { ReportsModule } from './reports/reports.module';
import { ActivityLogsModule } from './activity-logs/activity-logs.module';
import { DataProtectionModule } from './data-protection/data-protection.module';
import { InspectionModule } from './inspection/inspection.module';
import { InboundModule } from './inbound/inbound.module';
import { DockModule } from './dock/dock.module';
import { IncentivesModule } from './incentives/incentives.module';
import { MlGovernanceModule } from './ml-governance/ml-governance.module';
import { CustomerOpsModule } from './customer-ops/customer-ops.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
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
    PerformanceModule,
    ReportsModule,
    ActivityLogsModule,
    DataProtectionModule,
    InspectionModule,
    InboundModule,
    DockModule,
    IncentivesModule,
    MlGovernanceModule,
    CustomerOpsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
