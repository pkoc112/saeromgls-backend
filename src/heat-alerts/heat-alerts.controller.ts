import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { HeatAlertsService } from './heat-alerts.service';
import { CreateHeatAlertDto } from './dto/create-heat-alert.dto';
import { CreateHeatRecordDto } from './dto/create-heat-record.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Heat Alerts')
@Controller()
export class HeatAlertsController {
  constructor(private readonly heatAlertsService: HeatAlertsService) {}

  /**
   * 모바일에서 자가체크 결과 보고 (인증 필요)
   * - 'symptoms' 또는 'rest' 만 받음 ('ok' 는 모바일에서 발송 안 함)
   * - throttle: 분당 30회 (작업자 폭주 대비)
   */
  @Post('mobile/heat-alerts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '폭염 자가체크 알림 보고',
    description:
      '작업자가 증상 체크 시 호출 (Sentry + Gmail + DB 저장). 인증 필요.',
  })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateHeatAlertDto) {
    // ★ siteId는 JWT 우선 — 인증 작업자가 임의 siteId로 타 센터 알림을 위조/통계 왜곡하는 것 차단
    if (user?.siteId) dto.siteId = user.siteId;
    return this.heatAlertsService.create(dto);
  }

  /**
   * 모바일: 시간별 체감온도(WBGT) 기록 보고
   * - 앱이 날씨 갱신(30분 주기) 시 시간당 1회 전송 — 서버에서 시간 단위 dedup
   * - siteId는 JWT 우선, 없으면 body fallback
   */
  @Post('mobile/heat-records')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '시간별 체감온도 기록 보고',
    description: '앱 표시 WBGT 값을 시간 단위로 기록 (같은 시간대는 갱신). 인증 필요.',
  })
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  createRecord(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateHeatRecordDto,
  ) {
    const siteId = user?.siteId ?? dto.siteId ?? null;
    return this.heatAlertsService.recordHourly(siteId, dto);
  }

  /**
   * 모바일: 센터 설정 조회 (날씨/WBGT 좌표 등) — JWT siteId 기준
   * 미설정 시 기본 좌표(대구) 반환. 신규 센터의 지역별 날씨/폭염 판정에 사용.
   */
  @Get('mobile/site-config')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '센터 설정 조회 (날씨 좌표)',
    description: 'JWT siteId의 TenantSettings에서 latitude/longitude 반환. 미설정 시 대구 기본.',
  })
  getSiteConfig(@CurrentUser() user: JwtPayload) {
    return this.heatAlertsService.getSiteConfig(user?.siteId ?? null);
  }

  /**
   * 관리자: 시간별 체감온도 기록 조회 (KST 하루 단위)
   */
  @Get('admin/heat-records')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '시간별 체감온도 기록 조회',
    description: 'date(YYYY-MM-DD, KST) 하루의 시간별 WBGT 기록. 미지정 시 오늘.',
  })
  findHourlyRecords(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('date') date?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    // 하위호환: from/to 없이 date만 오면 그 날 하루 조회
    return this.heatAlertsService.findHourlyRecords(siteId, from ?? date, to ?? date);
  }

  /**
   * 관리자: 월별 체감온도 요약 (일별 최고/평균 + 단계별 일수)
   */
  @Get('admin/heat-records/monthly')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '월별 체감온도 요약',
    description: 'month(YYYY-MM, KST) 한 달의 일별 최고/평균 WBGT + 단계별 일수. 미지정 시 이번 달.',
  })
  findMonthlyStats(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('month') month?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.heatAlertsService.findMonthlyStats(siteId, month);
  }

  /**
   * 관리자: 월간 폭염 노출 리포트 (#39)
   * 시간별 WBGT 단계 × 작업 구간(시작자+참여자, 중간마감/휴게 차감) 교차 →
   * 작업자별 단계별 노출 분 + 기록 없는 시간(unknown) + 자가체크 알림 목록
   */
  @Get('admin/heat-records/exposure')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '월간 폭염 노출 리포트',
    description:
      'month(YYYY-MM, KST) 한 달의 작업자별 폭염 단계별 순작업(노출) 분 + 기록 없음 분 + 알림 건수. ' +
      '참여자(WorkAssignment) 포함, 기록 없는 시간대는 unknown. 미지정 시 이번 달.',
  })
  findMonthlyExposure(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('month') month?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.heatAlertsService.findMonthlyExposure(siteId, month);
  }

  /**
   * 관리자: 알림 목록 조회
   */
  @Get('admin/heat-alerts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('jwt')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '폭염 자가체크 알림 목록',
    description: '최근 30일 알림 목록 조회',
  })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('days') days?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    const d = days ? parseInt(days, 10) : 30;
    return this.heatAlertsService.findAll(siteId, d);
  }
}
