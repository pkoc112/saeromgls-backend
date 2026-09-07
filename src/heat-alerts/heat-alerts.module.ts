import { Module } from '@nestjs/common';
import { HeatAlertsController } from './heat-alerts.controller';
import { HeatAlertsService } from './heat-alerts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../common/notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [HeatAlertsController],
  providers: [HeatAlertsService],
  // 계약 [F]: CronModule 이 runHeatForecastNotices() 를 호출하므로 export 필수
  exports: [HeatAlertsService],
})
export class HeatAlertsModule {}
