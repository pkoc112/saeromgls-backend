import { Module } from '@nestjs/common';
import { CustomerOpsController } from './customer-ops.controller';
import { CustomerOpsService } from './customer-ops.service';

@Module({
  controllers: [CustomerOpsController],
  providers: [CustomerOpsService],
  exports: [CustomerOpsService],
})
export class CustomerOpsModule {}
