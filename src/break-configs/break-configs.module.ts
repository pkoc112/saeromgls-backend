import { Module } from '@nestjs/common';
import { BreakConfigsController } from './break-configs.controller';
import { BreakConfigsService } from './break-configs.service';

@Module({
  controllers: [BreakConfigsController],
  providers: [BreakConfigsService],
  exports: [BreakConfigsService],
})
export class BreakConfigsModule {}
