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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { IncentivesService } from './incentives.service';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { CreateScoreRunDto } from './dto/create-score-run.dto';
import { CreateObjectionDto } from './dto/create-objection.dto';
import { QueryPolicyDto, QueryScoreRunDto, QueryObjectionDto } from './dto/query-incentives.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Admin Incentives')
@ApiBearerAuth('jwt')
@Controller('admin/incentives')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IncentivesController {
  constructor(private readonly incentivesService: IncentivesService) {}

  // ======================== Policies ========================

  @Get('policies')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '인센티브 정책 목록 조회',
    description: '정책 버전 목록을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '정책 목록' })
  getPolicies(
    @Query() query: QueryPolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getPolicyVersions(siteId, query);
  }

  @Post('policies')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '인센티브 정책 생성',
    description: '새 정책 버전을 DRAFT 상태로 생성합니다.',
  })
  @ApiResponse({ status: 201, description: '정책 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  createPolicy(
    @Body() dto: CreatePolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined) || '';
    return this.incentivesService.createPolicyVersion(dto, siteId);
  }

  @Patch('policies/:id/status')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '정책 상태 변경',
    description: 'DRAFT -> SHADOW -> ACTIVE -> RETIRED 상태 전이.',
  })
  @ApiParam({ name: 'id', description: '정책 버전 UUID' })
  @ApiResponse({ status: 200, description: '상태 변경 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 상태 전이' })
  @ApiResponse({ status: 404, description: '정책 없음' })
  updatePolicyStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: string,
  ) {
    return this.incentivesService.updatePolicyStatus(id, status);
  }

  // ======================== Score Runs ========================

  @Post('score-runs')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '점수 계산 실행',
    description: '정책 버전과 월을 지정하여 점수를 계산합니다.',
  })
  @ApiResponse({ status: 201, description: '점수 계산 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  @ApiResponse({ status: 404, description: '정책 버전 없음' })
  createScoreRun(
    @Body() dto: CreateScoreRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined) || '';
    return this.incentivesService.createScoreRun(siteId, dto);
  }

  @Get('score-runs')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '점수 실행 목록 조회',
    description: '점수 계산 실행 이력을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '점수 실행 목록 + 페이지네이션 메타' })
  getScoreRuns(
    @Query() query: QueryScoreRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getScoreRuns(siteId, query);
  }

  @Get('score-runs/:id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '점수 실행 상세 조회',
    description: '점수 실행 상세 정보와 개인별 점수를 조회합니다.',
  })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  @ApiResponse({ status: 200, description: '점수 실행 상세' })
  @ApiResponse({ status: 404, description: '점수 실행 없음' })
  getScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.getScoreRun(id);
  }

  @Post('score-runs/:id/freeze')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '점수 실행 동결',
    description: '점수를 동결하여 더 이상 변경되지 않도록 합니다.',
  })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  @ApiResponse({ status: 200, description: '동결 완료' })
  @ApiResponse({ status: 400, description: '동결 불가 상태' })
  @ApiResponse({ status: 404, description: '점수 실행 없음' })
  freezeScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.freezeScoreRun(id);
  }

  @Post('score-runs/:id/finalize')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '점수 실행 확정',
    description: '동결된 점수를 최종 확정합니다.',
  })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  @ApiResponse({ status: 200, description: '확정 완료' })
  @ApiResponse({ status: 400, description: '확정 불가 상태' })
  @ApiResponse({ status: 404, description: '점수 실행 없음' })
  finalizeScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.finalizeScoreRun(id);
  }

  // ======================== Objections ========================

  @Get('objections')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '이의신청 목록 조회',
    description: '이의신청 목록을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '이의신청 목록 + 페이지네이션 메타' })
  getObjections(
    @Query() query: QueryObjectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getObjections(siteId, query);
  }

  @Post('objections')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '이의신청 접수',
    description: '점수에 대한 이의신청을 접수합니다.',
  })
  @ApiResponse({ status: 201, description: '이의신청 접수 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  createObjection(
    @Body() dto: CreateObjectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined) || '';
    return this.incentivesService.createObjection(dto, siteId, user.sub);
  }

  @Patch('objections/:id/resolve')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '이의신청 처리',
    description: '이의신청을 수락 또는 거부합니다.',
  })
  @ApiParam({ name: 'id', description: '이의신청 UUID' })
  @ApiResponse({ status: 200, description: '처리 완료' })
  @ApiResponse({ status: 400, description: '처리 불가 상태' })
  @ApiResponse({ status: 404, description: '이의신청 없음' })
  resolveObjection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('resolution') resolution: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.incentivesService.resolveObjection(id, resolution, user.sub);
  }
}
