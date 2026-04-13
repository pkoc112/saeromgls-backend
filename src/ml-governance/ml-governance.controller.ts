import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MlGovernanceService } from './ml-governance.service';
import {
  QueryPredictionsDto,
  QueryAnomaliesDto,
  QueryForecastDto,
  QueryDifficultyApprovalsDto,
  RejectDifficultyDto,
} from './dto/ml-governance.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Admin ML Governance')
@ApiBearerAuth('jwt')
@Controller('admin/ml')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MlGovernanceController {
  constructor(private readonly mlGovernanceService: MlGovernanceService) {}

  // ======================== Difficulty Approvals ========================

  @Post('difficulty/:id/approve')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: 'AI 난이도 추천 승인',
    description: '예측 로그를 승인하고 baseline_snapshot을 생성합니다.',
  })
  @ApiResponse({ status: 200, description: '승인 완료' })
  approveDifficulty(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.mlGovernanceService.approveDifficulty(id, user.sub);
  }

  @Post('difficulty/:id/reject')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: 'AI 난이도 추천 거절',
    description: '예측 로그를 거절합니다.',
  })
  @ApiResponse({ status: 200, description: '거절 완료' })
  rejectDifficulty(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDifficultyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.mlGovernanceService.rejectDifficulty(id, dto.reason, user.sub);
  }

  @Get('difficulty/pending')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '난이도 승인 대기 목록',
    description: '난이도 분석의 승인/거절/대기 목록을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '목록 조회 성공' })
  getDifficultyApprovals(
    @Query() query: QueryDifficultyApprovalsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.mlGovernanceService.getDifficultyApprovals(siteId, {
      month: query.month,
      status: query.status,
    });
  }

  // ======================== Anomalies ========================

  @Get('anomalies')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '이상 탐지',
    description: '지정 기간의 규칙 기반 이상 탐지를 실행합니다.',
  })
  @ApiResponse({ status: 200, description: '이상 탐지 결과' })
  detectAnomalies(
    @Query() query: QueryAnomaliesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.mlGovernanceService.detectAnomalies(siteId, query.from, query.to);
  }

  // ======================== Forecast ========================

  @Get('forecast')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '작업량 예측',
    description: '동일 요일 최근 7주 평균 기반 작업량 예측을 실행합니다.',
  })
  @ApiResponse({ status: 200, description: '예측 결과' })
  forecastWorkload(
    @Query() query: QueryForecastDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.mlGovernanceService.forecastWorkload(siteId, query.targetDate);
  }

  // ======================== Prediction Logs ========================

  @Get('predictions')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '예측 로그 목록',
    description: '예측/추천 로그를 페이지네이션으로 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '예측 로그 목록' })
  getPredictionLogs(
    @Query() query: QueryPredictionsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.mlGovernanceService.getPredictionLogs(
      siteId,
      query.type,
      query.page,
      query.limit,
    );
  }
}
