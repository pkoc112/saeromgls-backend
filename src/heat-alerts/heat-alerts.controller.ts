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
  create(@Body() dto: CreateHeatAlertDto) {
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
    @Query('date') date?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.heatAlertsService.findHourlyRecords(siteId, date);
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
