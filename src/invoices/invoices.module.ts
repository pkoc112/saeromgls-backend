import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../common/notifications/notifications.module';

@Module({
  // NotificationsModule: #48 청구서/연체/입금확인 메일 (InvoicesService 가 NotificationsService 주입)
  imports: [PrismaModule, NotificationsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService], // cron에서 호출
})
export class InvoicesModule {}
