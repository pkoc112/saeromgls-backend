import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { IncentivesModule } from '../incentives/incentives.module';

@Module({
  imports: [SubscriptionsModule, IncentivesModule],
  controllers: [CronController],
})
export class CronModule {}
