import { Module } from '@nestjs/common';
import { HeatAlertsController } from './heat-alerts.controller';
import { HeatAlertsService } from './heat-alerts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HeatAlertsController],
  providers: [HeatAlertsService],
})
export class HeatAlertsModule {}
