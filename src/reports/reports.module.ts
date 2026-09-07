import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [DashboardModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  // #32 일일/주간 요약 메일 — CronModule 이 ReportsService.buildSummaryMail 을 주입받기 위해 export
  exports: [ReportsService],
})
export class ReportsModule {}
