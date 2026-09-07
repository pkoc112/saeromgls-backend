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

  @Get('overview')
  @Roles('MASTER')
  getCustomerOverview(@Query('siteId') siteId?: string) {
    return this.customerOpsService.getCustomerOverview(siteId);
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
