import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsService } from './notifications.service';

/**
 * 알림 허브 모듈 (#25)
 * - PrismaModule 에만 의존 (순환 import 금지)
 * - 사용하는 모듈(HeatAlerts/Subscriptions/Cron 등)은 imports 에 NotificationsModule 추가 필수
 */
@Module({
  imports: [PrismaModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
