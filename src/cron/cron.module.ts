import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { IncentivesModule } from '../incentives/incentives.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { NotificationsModule } from '../common/notifications/notifications.module';
import { HeatAlertsModule } from '../heat-alerts/heat-alerts.module';
import { CustomerOpsModule } from '../customer-ops/customer-ops.module';
import { ReportsModule } from '../reports/reports.module';

/**
 * 크론 모듈 — CronController 가 주입받는 서비스의 모듈을 모두 imports 에 등록
 * (각 모듈은 해당 서비스를 exports 해야 함 — 누락 시 부팅 자체 실패, 2026-05-28 사고)
 * - NotificationsModule: 메일 허브(sendMail/resolveRecipients/masterEmail)
 * - HeatAlertsModule:    heat-forecast-notice (runHeatForecastNotices)
 * - CustomerOpsModule:   ops-digest (buildOpsDigest)
 * - ReportsModule:       evening-notices / weekly-summary (buildSummaryMail)
 * - SubscriptionsModule: subscription-check (+ notifyUpcomingExpirations)
 * PrismaModule 은 @Global 이라 별도 import 불필요.
 */
@Module({
  imports: [
    SubscriptionsModule,
    IncentivesModule,
    InvoicesModule,
    NotificationsModule,
    HeatAlertsModule,
    CustomerOpsModule,
    ReportsModule,
  ],
  controllers: [CronController],
})
export class CronModule {}
