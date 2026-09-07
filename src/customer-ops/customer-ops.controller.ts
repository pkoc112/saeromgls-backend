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
  BadRequestException,
} from '@nestjs/common';
import { JwtPayload, CurrentUser } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerOpsService } from './customer-ops.service';
import {
  CreateSiteFromTemplateDto,
  CreateSupportCaseDto,
  CustomerOverviewQueryDto,
  GenerateUsageSnapshotDto,
  ResolveSupportCaseDto,
  StartOnboardingRunDto,
  UpdateOnboardingRunDto,
  UpsertTenantSettingsDto,
} from './dto/customer-ops.dto';

@Controller('admin/customer-ops')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerOpsController {
  constructor(private readonly customerOpsService: CustomerOpsService) {}

  // #42 from/to (KST YYYY-MM-DD, 기본 이번 달) → site.period 기간 집계 + unassigned 행
  @Get('overview')
  @Roles('MASTER')
  getCustomerOverview(@Query() query: CustomerOverviewQueryDto) {
    return this.customerOpsService.getCustomerOverview(query.siteId, query.from, query.to);
  }

  // #29 개통 준비도 — ADMIN 은 자기 사업장, MASTER 는 siteId 없으면 최상위 활성 센터 전체
  @Get('readiness')
  @Roles('ADMIN')
  getReadiness(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.getReadiness(siteId);
  }

  // #30 센터 라이브 보드 — 최상위 활성 센터별 오늘/진행중/마지막 체감온도 보고
  @Get('live-board')
  @Roles('MASTER')
  getLiveBoard() {
    return this.customerOpsService.getLiveBoard();
  }

  @Get('operations-console')
  @Roles('ADMIN')
  getOperationsConsole(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.getOperationsConsole(siteId);
  }

  @Get('templates')
  @Roles('MASTER')
  getSiteTemplates() {
    return this.customerOpsService.getSiteTemplates();
  }

  @Post('sites-from-template')
  @Roles('MASTER')
  createSiteFromTemplate(@Body() dto: CreateSiteFromTemplateDto) {
    return this.customerOpsService.createSiteFromTemplate(dto);
  }

  @Get('support-cases')
  @Roles('ADMIN')
  getSupportCases(
    @Query('siteId') querySiteId: string | undefined,
    @Query('status') status?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.getSupportCases(siteId, status);
  }

  @Post('support-cases')
  @Roles('ADMIN')
  createSupportCase(
    @Body() dto: CreateSupportCaseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId 강제: 비-MASTER는 자기 사업장만 (|| fallthrough로 body siteId 위조 차단)
    const siteId = resolveSiteId(user, dto.siteId);
    if (!siteId) throw new BadRequestException('siteId가 필요합니다');
    dto.siteId = siteId;
    return this.customerOpsService.createSupportCase(dto);
  }

  @Patch('support-cases/:id/resolve')
  @Roles('MASTER')
  resolveSupportCase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSupportCaseDto,
  ) {
    return this.customerOpsService.resolveSupportCase(id, dto);
  }

  // 계정 잠금 해제 (MASTER) — 보안 콘솔에서 잠긴 작업자 즉시 해제
  @Post('unlock-account')
  @Roles('MASTER')
  unlockAccount(@Body('workerId', ParseUUIDPipe) workerId: string) {
    return this.customerOpsService.unlockAccount(workerId);
  }

  @Post('usage-snapshots')
  @Roles('MASTER')
  generateUsageSnapshot(@Body() dto: GenerateUsageSnapshotDto) {
    return this.customerOpsService.generateUsageSnapshot(dto);
  }

  @Get('usage-snapshots')
  @Roles('MASTER')
  getUsageSnapshots(@Query('siteId') siteId?: string) {
    return this.customerOpsService.getUsageSnapshots(siteId);
  }

  @Get('onboarding-runs')
  @Roles('ADMIN')
  getOnboardingRuns(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.getOnboardingRuns(siteId);
  }

  @Post('onboarding-runs')
  @Roles('ADMIN')
  startOnboardingRun(
    @Body() dto: StartOnboardingRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId 강제: 비-MASTER는 자기 사업장만 (|| fallthrough 차단)
    const siteId = resolveSiteId(user, dto.siteId);
    if (!siteId) throw new BadRequestException('siteId가 필요합니다');
    return this.customerOpsService.startOnboardingRun(siteId);
  }

  @Patch('onboarding-runs/:id')
  @Roles('ADMIN')
  updateOnboardingRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOnboardingRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customerOpsService.updateOnboardingRun(id, dto, user);
  }

  @Get('tenant-settings')
  @Roles('ADMIN')
  getTenantSettings(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.getTenantSettings(siteId);
  }

  @Patch('tenant-settings')
  @Roles('ADMIN')
  updateTenantSettings(
    @Query('siteId') querySiteId: string | undefined,
    @Body() dto: UpsertTenantSettingsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.customerOpsService.updateTenantSettings(siteId, dto);
  }
}
