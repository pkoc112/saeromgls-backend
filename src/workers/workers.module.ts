import { Module } from '@nestjs/common';
import { WorkersController } from './workers.controller';
import { WorkersService } from './workers.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule], // UsageLimitService 주입 (작업자 상한 강제)
  controllers: [WorkersController],
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
