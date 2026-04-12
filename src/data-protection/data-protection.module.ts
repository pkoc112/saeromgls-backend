import { Module } from '@nestjs/common';
import { DataProtectionController } from './data-protection.controller';
import { DataProtectionService } from './data-protection.service';

@Module({
  controllers: [DataProtectionController],
  providers: [DataProtectionService],
  exports: [DataProtectionService],
})
export class DataProtectionModule {}
