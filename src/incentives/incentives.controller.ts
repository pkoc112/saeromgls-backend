import {
  BadRequestException,
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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Feature } from '../common/decorators/feature.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { resolveSiteId } from '../common/utils/site-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateObjectionDto } from './dto/create-objection.dto';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { CreateScoreRunDto } from './dto/create-score-run.dto';
import { QueryObjectionDto, QueryPolicyDto, QueryScoreRunDto } from './dto/query-incentives.dto';
import { IncentivesService } from './incentives.service';

@ApiTags('Admin Incentives')
@ApiBearerAuth('jwt')
@Controller('admin/incentives')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
// ★ 인센티브 모듈 전체에 EntitlementGuard 적용 — Plan.features에 'INCENTIVE' 있어야 사용 가능
@Feature('INCENTIVE')
export class IncentivesController {
  constructor(
    private readonly incentivesService: IncentivesService,
    private readonly prisma: PrismaService,
  ) {}

  private requireSiteId(user: JwtPayload, querySiteId?: string) {
    const siteId = resolveSiteId(user, querySiteId);
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }
    return siteId;
  }

  @Get('policies')
  @Roles('ADMIN')
  @ApiOperation({ summary: '인센티브 정책 목록 조회' })
  @ApiResponse({ status: 200, description: '정책 목록' })
  getPolicies(@Query() query: QueryPolicyDto, @CurrentUser() user: JwtPayload) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getPolicyVersions(siteId, query);
  }

  @Post('policies/migrate-v3')
  @Roles('ADMIN')
  @ApiOperation({ summary: '기존 5트랙 정책을 4트랙 v3 정책으로 마이그레이션' })
  async migratePoliciesV3(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    const retired = await this.prisma.policyVersion.updateMany({
      where: { status: { in: ['DRAFT', 'SHADOW', 'ACTIVE'] }, ...(siteId ? { siteId } : {}) },
      data: { status: 'RETIRED', effectiveTo: new Date() },
    });

    const sites = siteId
      ? [{ id: siteId }]
      : await this.prisma.site.findMany({
          where: { isActive: true },
          select: { id: true },
        });

    const newTracks = [
      {
        track: 'OUTBOUND',
        name: '출고 전담 정책 v3',
        perf: 55,
        rel: 30,
        team: 15,
        desc: '처리량 40 + 효율 30 + 물동량 30 | 절대평가',
      },
      {
        track: 'INBOUND_DOCK',
        name: '입고·상하차 정책 v3',
        perf: 55,
        rel: 30,
        team: 15,
        desc: '입고세션 25 + 수량 25 + 출고참여 25 + 정확도 25 | 입출고 통합',
      },
      {
        track: 'INSPECTION',
        name: '검수 전담 정책 v3',
        perf: 55,
        rel: 30,
        team: 15,
        desc: '검수건수 35 + 검출률 40 + 커버리지 25 | 절대평가',
      },
      {
        track: 'MANAGER',
        name: '현장관리자 정책 v3',
        perf: 40,
        rel: 35,
        team: 25,
        desc: '팀성과 35 + 예외처리 35 + 커버리지 30 | 관리자 전용',
      },
    ];

    const created: Array<{ id: string; track: string; name: string }> = [];
    for (const site of sites) {
      for (const track of newTracks) {
        const pv = await this.prisma.policyVersion.create({
          data: {
            siteId: site.id,
            name: track.name,
            description: track.desc,
            track: track.track,
            weights: JSON.stringify({
              performance: track.perf,
              reliability: track.rel,
              teamwork: track.team,
            }),
            status: 'SHADOW',
            effectiveFrom: new Date(),
          },
        });
        created.push({ id: pv.id, track: pv.track, name: pv.name });
      }
    }

    return {
      message: `마이그레이션 완료: ${retired.count}개 폐기, ${created.length}개 생성`,
      retired: retired.count,
      created: created.length,
      newPolicies: created,
    };
  }

  @Post('policies')
  @Roles('ADMIN')
  @ApiOperation({ summary: '인센티브 정책 생성' })
  @ApiResponse({ status: 201, description: '정책 생성 완료' })
  createPolicy(
    @Query('siteId') querySiteId: string | undefined,
    @Body() dto: CreatePolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = this.requireSiteId(user, querySiteId);
    return this.incentivesService.createPolicyVersion(dto, siteId);
  }

  @Patch('policies/:id/status')
  @Roles('ADMIN')
  @ApiOperation({ summary: '정책 상태 변경' })
  @ApiParam({ name: 'id', description: '정책 버전 UUID' })
  updatePolicyStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: string,
  ) {
    return this.incentivesService.updatePolicyStatus(id, status);
  }

  @Post('score-runs')
  @Roles('ADMIN')
  @ApiOperation({ summary: '점수 계산 실행' })
  @ApiResponse({ status: 201, description: '점수 계산 완료' })
  createScoreRun(
    @Query('siteId') querySiteId: string | undefined,
    @Body() dto: CreateScoreRunDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = this.requireSiteId(user, querySiteId);
    return this.incentivesService.createScoreRun(siteId, dto);
  }

  @Post('score-runs/run-all')
  @Roles('ADMIN')
  @ApiOperation({ summary: '4트랙 전체 점수 일괄 실행 (해당 월의 ACTIVE/SHADOW 정책 각각 실행)' })
  runAllTracks(
    @Query('siteId') querySiteId: string | undefined,
    @Body('month') month: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = this.requireSiteId(user, querySiteId);
    return this.incentivesService.runAllTracks(siteId, month);
  }

  @Get('score-runs')
  @Roles('ADMIN')
  @ApiOperation({ summary: '점수 실행 목록 조회' })
  getScoreRuns(@Query() query: QueryScoreRunDto, @CurrentUser() user: JwtPayload) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getScoreRuns(siteId, query);
  }

  @Get('score-runs/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: '점수 실행 상세 조회' })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  getScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.getScoreRun(id);
  }

  @Post('score-runs/:id/freeze')
  @Roles('ADMIN')
  @ApiOperation({ summary: '점수 실행 동결' })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  freezeScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.freezeScoreRun(id);
  }

  @Post('score-runs/:id/finalize')
  @Roles('ADMIN')
  @ApiOperation({ summary: '점수 실행 확정' })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  finalizeScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.finalizeScoreRun(id);
  }

  @Post('score-runs/:id/recalculate')
  @Roles('ADMIN')
  @ApiOperation({ summary: '이의신청 반영 재계산' })
  @ApiParam({ name: 'id', description: '원본 점수 실행 UUID' })
  recalculateScoreRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.incentivesService.recalculateAfterObjection(id);
  }

  @Get('objections')
  @Roles('ADMIN')
  @ApiOperation({ summary: '이의신청 목록 조회' })
  getObjections(@Query() query: QueryObjectionDto, @CurrentUser() user: JwtPayload) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.incentivesService.getObjections(siteId, query);
  }

  @Post('objections')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({ summary: '이의신청 등록' })
  createObjection(
    @Query('siteId') querySiteId: string | undefined,
    @Body() dto: CreateObjectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = this.requireSiteId(user, querySiteId);
    return this.incentivesService.createObjection(dto, siteId, user.sub);
  }

  @Patch('objections/:id/resolve')
  @Roles('ADMIN')
  @ApiOperation({ summary: '이의신청 처리' })
  @ApiParam({ name: 'id', description: '이의신청 UUID' })
  resolveObjection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('resolution') resolution: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.incentivesService.resolveObjection(id, resolution, user.sub);
  }

  @Get('policy-packs')
  @Roles('ADMIN')
  @ApiOperation({ summary: '정책 팩 목록 조회' })
  getPolicyPacks() {
    return this.incentivesService.getPolicyPackTemplates();
  }

  @Post('policy-packs/:id/apply')
  @Roles('ADMIN')
  @ApiOperation({ summary: '정책 팩 적용' })
  @ApiParam({ name: 'id', description: '정책 팩 UUID' })
  applyPolicyPack(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = this.requireSiteId(user, querySiteId);
    return this.incentivesService.applyPolicyPack(id, siteId);
  }

  @Get('score-runs/:id/payout-preview')
  @Roles('ADMIN')
  @ApiOperation({ summary: '지급 시뮬레이션' })
  @ApiParam({ name: 'id', description: '점수 실행 UUID' })
  getPayoutPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('baseIncentive') baseIncentiveStr?: string,
  ) {
    const baseIncentive = baseIncentiveStr ? Number(baseIncentiveStr) : 500000;
    return this.incentivesService.generatePayoutDryRun(id, baseIncentive);
  }
}
