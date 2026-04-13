import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CustomerOpsService } from './customer-ops.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CreateSiteFromTemplateDto,
  CreateSupportCaseDto,
  ResolveSupportCaseDto,
  GenerateUsageSnapshotDto,
} from './dto/customer-ops.dto';

@Controller('admin/customer-ops')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerOpsController {
  constructor(private readonly customerOpsService: CustomerOpsService) {}

  /**
   * 고객 현황 개요 (MASTER 전용)
   */
  @Get('overview')
  @Roles('MASTER')
  getCustomerOverview() {
    return this.customerOpsService.getCustomerOverview();
  }

  /**
   * 사업장 템플릿 목록 (MASTER 전용)
   */
  @Get('templates')
  @Roles('MASTER')
  getSiteTemplates() {
    return this.customerOpsService.getSiteTemplates();
  }

  /**
   * 템플릿 기반 사업장 생성 (MASTER 전용)
   */
  @Post('sites-from-template')
  @Roles('MASTER')
  createSiteFromTemplate(@Body() dto: CreateSiteFromTemplateDto) {
    return this.customerOpsService.createSiteFromTemplate(dto);
  }

  /**
   * 지원 케이스 목록 조회 (ADMIN 이상)
   */
  @Get('support-cases')
  @Roles('ADMIN')
  getSupportCases(
    @Query('siteId') siteId?: string,
    @Query('status') status?: string,
  ) {
    return this.customerOpsService.getSupportCases(siteId, status);
  }

  /**
   * 지원 케이스 생성 (ADMIN 이상)
   */
  @Post('support-cases')
  @Roles('ADMIN')
  createSupportCase(@Body() dto: CreateSupportCaseDto) {
    return this.customerOpsService.createSupportCase(dto);
  }

  /**
   * 지원 케이스 해결 (MASTER 전용)
   */
  @Patch('support-cases/:id/resolve')
  @Roles('MASTER')
  resolveSupportCase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSupportCaseDto,
  ) {
    return this.customerOpsService.resolveSupportCase(id, dto);
  }

  /**
   * 사용량 스냅샷 생성 (MASTER 전용)
   */
  @Post('usage-snapshots')
  @Roles('MASTER')
  generateUsageSnapshot(@Body() dto: GenerateUsageSnapshotDto) {
    return this.customerOpsService.generateUsageSnapshot(dto);
  }

  /**
   * 사용량 스냅샷 목록 조회 (MASTER 전용)
   */
  @Get('usage-snapshots')
  @Roles('MASTER')
  getUsageSnapshots(@Query('siteId') siteId?: string) {
    return this.customerOpsService.getUsageSnapshots(siteId);
  }
}
