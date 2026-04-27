import { Controller, Get, Post, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';
import { IsDateString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * AI 분석 요청 DTO
 */
class AiAnalysisRequestDto {
  @ApiProperty({
    description: '분석 시작 날짜 (YYYY-MM-DD)',
    example: '2026-04-01',
  })
  @IsDateString()
  @IsNotEmpty()
  fromDate: string;

  @ApiProperty({
    description: '분석 종료 날짜 (YYYY-MM-DD)',
    example: '2026-04-07',
  })
  @IsDateString()
  @IsNotEmpty()
  toDate: string;
}

@Controller('admin/ai')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@Feature('AI_INSIGHT')
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin AI')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('weekly-summary')
  @ApiOperation({
    summary: '주간 요약 생성',
    description:
      'Claude AI를 사용하여 지정 기간의 작업 데이터 주간 요약 리포트를 생성합니다. ' +
      'PII 최소화를 위해 작업자 이름 대신 사번을 사용합니다.',
  })
  @ApiBody({ type: AiAnalysisRequestDto })
  @ApiResponse({ status: 201, description: '주간 요약 인사이트 생성 완료' })
  @ApiResponse({ status: 503, description: 'AI 서비스 사용 불가' })
  generateWeeklySummary(
    @Body() dto: AiAnalysisRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId 격리: MASTER만 전체, 그 외엔 자기 사업장
    const siteId = resolveSiteId(user, undefined);
    return this.aiService.generateWeeklySummary(dto.fromDate, dto.toDate, siteId);
  }

  @Post('anomaly-detection')
  @ApiOperation({
    summary: '이상 탐지',
    description:
      'Claude AI를 사용하여 지정 기간의 작업 데이터에서 이상 패턴을 탐지합니다. ' +
      '비정상 작업 시간, 물량 이상, 중복 작업 등을 분석합니다.',
  })
  @ApiBody({ type: AiAnalysisRequestDto })
  @ApiResponse({ status: 201, description: '이상 탐지 인사이트 생성 완료' })
  @ApiResponse({ status: 503, description: 'AI 서비스 사용 불가' })
  detectAnomalies(
    @Body() dto: AiAnalysisRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId 격리: MASTER만 전체, 그 외엔 자기 사업장
    const siteId = resolveSiteId(user, undefined);
    return this.aiService.detectAnomalies(dto.fromDate, dto.toDate, siteId);
  }

  @Post('difficulty-analysis')
  @ApiOperation({
    summary: '납품처 난이도 분석',
    description:
      'Claude AI를 사용하여 납품처별 작업 난이도를 분석합니다. ' +
      'CBM당 소요시간, 작업시간 편차, 투입인원 등을 기반으로 A~E 등급을 매깁니다.',
  })
  @ApiBody({ type: AiAnalysisRequestDto })
  @ApiResponse({ status: 201, description: '난이도 분석 완료' })
  analyzeDifficulty(
    @Body() dto: AiAnalysisRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined);
    return this.aiService.analyzeDifficulty(dto.fromDate, dto.toDate, siteId);
  }

  @Post('generate-policy-pack')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'AI 엔터프라이즈 정책 팩 생성',
    description: 'Claude API가 실제 운영 데이터를 분석하여 5개 트랙별 최적 가중치를 추천하고 정책을 자동 생성합니다.',
  })
  @ApiResponse({ status: 201, description: '정책 팩 생성 완료' })
  generatePolicyPack(@CurrentUser() user: JwtPayload) {
    const siteId = user.siteId;
    if (!siteId) throw new BadRequestException('사업장 정보가 필요합니다');
    return this.aiService.generatePolicyPack(siteId);
  }

  @Get('insights')
  @ApiOperation({
    summary: '생성된 인사이트 목록',
    description: 'AI가 생성한 주간 요약 및 이상 탐지 결과 목록을 조회합니다.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['WEEKLY_SUMMARY', 'ANOMALY', 'DIFFICULTY_ANALYSIS'],
    description: '인사이트 유형 필터',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: '인사이트 목록 + 페이지네이션' })
  getInsights(
    @Query('type') type?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.aiService.getInsights({ type, page, limit });
  }
}
