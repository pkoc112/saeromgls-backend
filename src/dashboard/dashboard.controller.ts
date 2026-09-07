import { Controller, Get, Post, Query, Body, Res, UseGuards, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'KPI 통계 조회' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getStats(@Query('from') from: string, @Query('to') to: string, @Query('siteId') querySiteId: string | undefined, @CurrentUser() user: JwtPayload) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getStats(from, to, siteId);
  }

  @Get('trends')
  @ApiOperation({ summary: '트렌드 데이터 (차트용)' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'groupBy', required: false, enum: ['hour', 'day', 'week', 'month'] })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getTrends(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('groupBy') groupBy: 'hour' | 'day' | 'week' | 'month' | undefined,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getTrends(from, to, groupBy, siteId);
  }

  @Get('export')
  @UseGuards(EntitlementGuard)
  @Feature('CSV_EXPORT')
  @ApiOperation({ summary: 'CSV 내보내기' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  async exportData(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string,
    @Res() res: Response,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    const csvContent = await this.dashboardService.exportCsv(from, to, siteId);
    const filename = `work-items-${from}-to-${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  }

  @Get('worker-stats')
  @ApiOperation({ summary: '작업자별 통계' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  getWorkerStats(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getWorkerStats(siteId, from, to);
  }

  @Get('worker-time-summary')
  @ApiOperation({ summary: '작업자별 작업시간 요약 (#36) — 근무일수/첫시작·마지막종료 평균/순작업시간/건수' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getWorkerTimeSummary(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getWorkerTimeSummary(from, to, siteId);
  }

  @Get('trends-by-classification')
  @ApiOperation({ summary: '거래처(분류)별 일별 물동량 명세 (#37) — 피벗용' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'classificationId', required: false, type: String })
  getTrendsByClassification(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @Query('classificationId') classificationId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getTrendsByClassification(from, to, siteId, classificationId);
  }

  @Get('load-profile')
  @ApiOperation({ summary: '시간대별 부하 프로필 (#50) — 요일×시각 평균 동시작업 인원' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getLoadProfile(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getLoadProfile(from, to, siteId);
  }

  @Get('comparison')
  @ApiOperation({ summary: '전기 대비 증감 비교' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getComparison(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getComparison(from, to, siteId);
  }

  @Get('alerts')
  @ApiOperation({ summary: '이상 작업 탐지 알림' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getAlerts(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.dashboardService.getAlerts(from, to, siteId);
  }

  @Get('goals')
  @ApiOperation({ summary: '대시보드 목표 조회' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  getGoals(
    @Query('siteId') querySiteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    if (!siteId) throw new BadRequestException('siteId가 필요합니다');
    return this.dashboardService.getGoals(siteId);
  }

  @Post('goals')
  @Roles('ADMIN')
  @ApiOperation({ summary: '대시보드 목표 생성' })
  createGoal(
    @Body() body: { siteId: string; periodType: string; targetCount?: number; targetVolume?: number; targetQuantity?: number },
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId 강제: 비-MASTER는 자기 사업장만 (falsy JWT siteId일 때 body.siteId fallthrough 차단)
    const siteId = resolveSiteId(user, body.siteId);
    if (!siteId) throw new BadRequestException('siteId가 필요합니다');
    body.siteId = siteId;
    if (!body.periodType) throw new BadRequestException('periodType이 필요합니다');
    return this.dashboardService.createGoal(body);
  }

  private validateDateRange(from: string, to: string) {
    if (!from || !to) throw new BadRequestException('from과 to 날짜가 모두 필요합니다');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) throw new BadRequestException('올바른 날짜 형식이 아닙니다');
    if (fromDate > toDate) throw new BadRequestException('시작 날짜가 종료 날짜보다 늦을 수 없습니다');
  }
}
