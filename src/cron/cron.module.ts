import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule],
  controllers: [CronController],
})
export class CronModule {}
