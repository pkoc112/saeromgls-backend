import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { UsageLimitService } from './usage-limit.service';

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, UsageLimitService],
  exports: [SubscriptionsService, UsageLimitService],
})
export class SubscriptionsModule {}
