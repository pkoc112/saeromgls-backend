import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { UsageLimitService } from './usage-limit.service';
import { NotificationsModule } from '../common/notifications/notifications.module';

@Module({
  // #17 구독 만료 D-day 알림: SubscriptionsService 가 NotificationsService 주입 (PrismaModule 은 @Global)
  imports: [NotificationsModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, UsageLimitService],
  exports: [SubscriptionsService, UsageLimitService],
})
export class SubscriptionsModule {}
