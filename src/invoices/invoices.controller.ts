import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Invoices')
@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('jwt')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @Roles('ADMIN')
  @ApiOperation({ summary: '인보이스 목록 (사이트 격리)' })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('status') status?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.invoicesService.findAll(siteId, status);
  }

  @Get(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: '인보이스 상세 (사이트 격리)' })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // resolveSiteId: 비-MASTER는 JWT siteId 강제, MASTER는 null(전체 허용)
    const siteId = resolveSiteId(user);
    return this.invoicesService.findOne(id, siteId);
  }

  @Post(':id/issue')
  @Roles('MASTER')
  @ApiOperation({ summary: '인보이스 발행 (DRAFT → ISSUED, MASTER 전용)' })
  issue(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoicesService.issue(id);
  }

  @Post(':id/mark-paid')
  @Roles('MASTER')
  @ApiOperation({ summary: '입금 확인 (→ PAID + 구독 자동 연장, MASTER 전용)' })
  markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { paymentMethod?: string; paymentNote?: string },
  ) {
    return this.invoicesService.markPaid(id, dto || {});
  }

  @Patch(':id/cancel')
  @Roles('MASTER')
  @ApiOperation({ summary: '인보이스 취소 (MASTER 전용)' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason?: string },
  ) {
    return this.invoicesService.cancel(id, dto?.reason);
  }

  @Post('generate-now')
  @Roles('MASTER')
  @ApiOperation({ summary: '[수동] 이번달 인보이스 일괄 생성 (MASTER 전용, 테스트용)' })
  generateNow(@Body() dto: { month?: string }) {
    return this.invoicesService.generateMonthlyInvoices(dto?.month);
  }
}
