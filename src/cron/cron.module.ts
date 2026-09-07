import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { IncentivesModule } from '../incentives/incentives.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [SubscriptionsModule, IncentivesModule, InvoicesModule],
  controllers: [CronController],
})
export class CronModule {}
