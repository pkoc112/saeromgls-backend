import { Module } from '@nestjs/common';
import { MlGovernanceController } from './ml-governance.controller';
import { MlGovernanceService } from './ml-governance.service';

@Module({
  controllers: [MlGovernanceController],
  providers: [MlGovernanceService],
  exports: [MlGovernanceService],
})
export class MlGovernanceModule {}
