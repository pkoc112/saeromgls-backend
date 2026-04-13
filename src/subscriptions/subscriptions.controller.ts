import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SubscriptionsService, SubscriptionStatus } from './subscriptions.service';
import { UsageLimitService } from './usage-limit.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { StartTrialDto } from './dto/create-subscription.dto';
import {
  ChangePlanDto,
  SiteIdDto,
  GrantTrialDto,
  TransitionStatusDto,
} from './dto/admin-subscription.dto';

@Controller('admin')
@ApiTags('Subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly usageLimitService: UsageLimitService,
  ) {}

  // ──────────────────────────────────────────────
  // GET /api/admin/plans — 플랜 목록 (공개)
  // ──────────────────────────────────────────────
  @Get('plans')
  @ApiOperation({
    summary: '구독 플랜 목록 조회',
    description: '활성화된 모든 구독 플랜을 조회합니다. 인증 불필요.',
  })
  @ApiResponse({ status: 200, description: '플랜 목록' })
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/subscriptions — 현재 구독 상태 (JWT)
  // ──────────────────────────────────────────────
  @Get('subscriptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '현재 사이트 구독 상태 조회',
    description: '로그인한 사용자의 소속 사업장 구독 정보를 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '구독 상태 정보' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  getSubscription(@CurrentUser() user: JwtPayload) {
    if (!user.siteId) {
      throw new BadRequestException('소속 사업장이 없습니다');
    }
    return this.subscriptionsService.getSubscription(user.siteId);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/start-trial — 14일 무료 체험 (JWT)
  // ──────────────────────────────────────────────
  @Post('subscriptions/start-trial')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '14일 무료 체험 시작',
    description:
      '지정 사업장에 대해 14일 무료 체험을 시작합니다. 사업장당 1회만 가능.',
  })
  @ApiResponse({ status: 201, description: '체험 시작 성공' })
  @ApiResponse({ status: 400, description: '이미 구독/체험 중' })
  @ApiResponse({ status: 403, description: '이미 체험 사용 완료' })
  startTrial(@Body() dto: StartTrialDto) {
    return this.subscriptionsService.startTrial(dto.siteId, dto.planCode);
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/billing/current-plan — 현재 플랜 + 구독 상태
  // ──────────────────────────────────────────────
  @Get('billing/current-plan')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '현재 플랜 및 구독 상태 조회',
    description:
      '로그인한 사용자의 소속 사업장 현재 플랜과 구독 상태를 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '현재 플랜 + 구독 상태' })
  getCurrentPlan(@CurrentUser() user: JwtPayload) {
    if (!user.siteId) {
      throw new BadRequestException('소속 사업장이 없습니다');
    }
    return this.subscriptionsService.getCurrentPlan(user.siteId);
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/billing/usage — 사용량 vs 상한
  // ──────────────────────────────────────────────
  @Get('billing/usage')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '사용량 조회',
    description:
      '작업자 수, 사업장 수 등 현재 사용량과 플랜별 상한을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '사용량 vs 상한' })
  getUsage(@CurrentUser() user: JwtPayload) {
    if (!user.siteId) {
      throw new BadRequestException('소속 사업장이 없습니다');
    }
    return this.usageLimitService.getUsage(user.siteId);
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/billing/feature-access — 접근 가능한 기능 목록
  // ──────────────────────────────────────────────
  @Get('billing/feature-access')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '접근 가능한 기능 목록 조회',
    description:
      '현재 구독 플랜에서 사용할 수 있는 기능 목록을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '기능 목록' })
  getFeatureAccess(@CurrentUser() user: JwtPayload) {
    if (!user.siteId) {
      throw new BadRequestException('소속 사업장이 없습니다');
    }
    return this.subscriptionsService.getFeatureAccess(user.siteId);
  }

  // ══════════════════════════════════════════════
  // MASTER 전용 구독 관리 엔드포인트
  // ══════════════════════════════════════════════

  /** MASTER 역할 검증 헬퍼 */
  private ensureMaster(user: JwtPayload) {
    if (user.role !== 'MASTER') {
      throw new ForbiddenException('MASTER 권한이 필요합니다');
    }
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/subscriptions/all — 전체 사업장 구독 현황 (MASTER)
  // ──────────────────────────────────────────────
  @Get('subscriptions/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '전체 사업장 구독 현황 목록',
    description: 'MASTER: 모든 사업장의 구독 현황을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '전체 구독 현황 목록' })
  getAllSubscriptions(@CurrentUser() user: JwtPayload) {
    this.ensureMaster(user);
    return this.subscriptionsService.getAllSubscriptions();
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/change-plan — 사업장 플랜 변경 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/change-plan')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '사업장 플랜 변경',
    description: 'MASTER: 사업장의 구독 플랜을 변경합니다.',
  })
  @ApiResponse({ status: 201, description: '플랜 변경 성공' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  changePlan(@CurrentUser() user: JwtPayload, @Body() dto: ChangePlanDto) {
    this.ensureMaster(user);
    return this.subscriptionsService.changePlan(dto.siteId, dto.planCode);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/activate — 구독 활성화 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/activate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '구독 활성화',
    description: 'MASTER: 입금 확인 후 사업장 구독을 활성화합니다.',
  })
  @ApiResponse({ status: 201, description: '활성화 성공' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  activateSubscription(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SiteIdDto,
  ) {
    this.ensureMaster(user);
    return this.subscriptionsService.activateSubscription(dto.siteId);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/cancel — 구독 해지 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '구독 해지',
    description: 'MASTER: 사업장의 구독을 해지합니다.',
  })
  @ApiResponse({ status: 201, description: '해지 성공' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  cancelSubscription(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SiteIdDto,
  ) {
    this.ensureMaster(user);
    return this.subscriptionsService.cancelSubscription(dto.siteId);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/grant-trial — 무료 체험 부여 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/grant-trial')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '무료 체험 부여',
    description: 'MASTER: 사업장에 무료 체험 기간을 부여합니다.',
  })
  @ApiResponse({ status: 201, description: '체험 부여 성공' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  grantTrial(@CurrentUser() user: JwtPayload, @Body() dto: GrantTrialDto) {
    this.ensureMaster(user);
    return this.subscriptionsService.grantTrial(dto.siteId, dto.days);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/:id/transition — 구독 상태 전이 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/:id/transition')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '구독 상태 전이',
    description:
      'MASTER: 구독 상태를 전이합니다. 허용된 전이만 가능합니다. ' +
      '(TRIAL→ACTIVE, TRIAL→CANCELLED, ACTIVE→PAST_DUE, ACTIVE→CANCELLED, ' +
      'PAST_DUE→ACTIVE, PAST_DUE→SUSPENDED, SUSPENDED→ACTIVE, SUSPENDED→CANCELLED)',
  })
  @ApiResponse({ status: 201, description: '상태 전이 성공' })
  @ApiResponse({ status: 400, description: '허용되지 않은 상태 전이' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  @ApiResponse({ status: 404, description: '구독을 찾을 수 없음' })
  transitionStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: TransitionStatusDto,
  ) {
    this.ensureMaster(user);
    return this.subscriptionsService.transitionStatus(
      id,
      dto.status as SubscriptionStatus,
      dto.reason,
      user.sub,
    );
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/check-expirations — 만료 체험 일괄 처리 (MASTER)
  // ──────────────────────────────────────────────
  @Post('subscriptions/check-expirations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '만료된 체험/구독 일괄 처리',
    description:
      'MASTER: 만료된 체험 구독을 EXPIRED로, 유예기간 초과 PAST_DUE를 SUSPENDED로 전이합니다.',
  })
  @ApiResponse({ status: 201, description: '일괄 처리 결과' })
  @ApiResponse({ status: 403, description: 'MASTER 권한 필요' })
  async checkExpirations(@CurrentUser() user: JwtPayload) {
    this.ensureMaster(user);
    const [trialResult, pastDueResult] = await Promise.all([
      this.subscriptionsService.checkTrialExpirations(),
      this.subscriptionsService.checkPastDueSuspensions(),
    ]);
    return {
      trials: trialResult,
      pastDue: pastDueResult,
      message: `처리 완료: 체험 만료 ${trialResult.processed}건, PAST_DUE → SUSPENDED ${pastDueResult.processed}건`,
    };
  }
}
