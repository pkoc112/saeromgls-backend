import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../common/notifications/notifications.service';

// ══════════════════════════════════════════════
// 구독 상태 전이 상수 (State Machine)
// ══════════════════════════════════════════════
export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * 허용된 상태 전이 맵
 *   key   = 현재 상태
 *   value = 전이 가능한 상태 목록
 */
export const VALID_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  TRIAL:     ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  ACTIVE:    ['PAST_DUE', 'CANCELLED'],
  PAST_DUE:  ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
  EXPIRED:   [],
};

// ══════════════════════════════════════════════
// #17 구독 만료 D-day 알림 내부 타입
// ══════════════════════════════════════════════

/** 만료 알림 후보 구독 (site/plan 최소 select 포함) */
type ExpiryCandidate = {
  id: string;
  siteId: string;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
  site: {
    id: string;
    name: string;
    code: string;
    isActive: boolean;
    parentSiteId: string | null;
  } | null;
  plan: {
    name: string;
    code: string;
    priceMonthly: number;
    maxWorkers: number;
  } | null;
};

/** 체험 만료 메일의 플랜 안내표용 */
type PlanSummary = {
  name: string;
  code: string;
  priceMonthly: number;
  maxWorkers: number;
};

/** MASTER 다이제스트 한 행 */
type ExpiryDigestItem = {
  siteName: string;
  siteCode: string;
  status: SubscriptionStatus;
  planName: string;
  /** 만료 기준일 (KST 'YYYY-MM-DD') */
  dateKey: string;
  daysLeft: number;
  /** 오늘 고객 발송 결과 요약 */
  noticeOutcome: string;
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  /** 무료 체험 기간 (일) */
  private readonly TRIAL_DAYS = 14;

  /** PAST_DUE 상태 유지 최대 일수 (초과 시 SUSPENDED) */
  private readonly PAST_DUE_GRACE_DAYS = 7;

  /** PAST_DUE → SUSPENDED 까지의 유예 일수 */
  private readonly SUSPENDED_GRACE_DAYS = 30;

  // ── #17 구독 만료 D-day 알림 발송 시점 (KST 날짜 정확 매칭) ──
  /** TRIAL: trialEndsAt 기준 D-N 에 발송 */
  private readonly TRIAL_NOTICE_DAYS = [7, 3, 1];
  /** ACTIVE: currentPeriodEnd 기준 D-N 에 결제 안내 */
  private readonly ACTIVE_NOTICE_DAYS = [7];
  /** PAST_DUE: 유예 종료일(currentPeriodEnd + SUSPENDED_GRACE_DAYS) 기준 D-N 에 정지 예정 안내 */
  private readonly PAST_DUE_NOTICE_DAYS = [3];
  /** MASTER 다이제스트: 오늘부터 N일 이내 만료 예정 건 */
  private readonly MASTER_DIGEST_WINDOW_DAYS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ──────────────────────────────────────────────
  // 플랜 목록 조회
  // ──────────────────────────────────────────────
  async getPlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { priceMonthly: 'asc' },
    });
  }

  // ──────────────────────────────────────────────
  // 구독 상태 자동 전이 체크 (상태 머신 기반)
  // TRIAL → (14일 후) → EXPIRED
  // ACTIVE → (기간 만료) → PAST_DUE → (30일) → SUSPENDED
  // ──────────────────────────────────────────────
  async checkSubscriptionStatus(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!subscription) return null;

    const now = new Date();
    const currentStatus = subscription.status as SubscriptionStatus;
    let targetStatus: SubscriptionStatus | null = null;
    let reason = '';

    // TRIAL → EXPIRED (체험 기간 만료)
    if (
      currentStatus === 'TRIAL' &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt < now
    ) {
      targetStatus = 'EXPIRED';
      reason = '체험 기간 만료 (자동)';
    }

    // ACTIVE → PAST_DUE (기간 만료 시)
    if (
      currentStatus === 'ACTIVE' &&
      subscription.currentPeriodEnd < now
    ) {
      targetStatus = 'PAST_DUE';
      reason = '구독 기간 만료 — 결제 필요 (자동)';
    }

    // PAST_DUE → SUSPENDED (유예기간 초과)
    if (currentStatus === 'PAST_DUE') {
      const gracePeriodEnd = new Date(subscription.currentPeriodEnd);
      gracePeriodEnd.setDate(
        gracePeriodEnd.getDate() + this.SUSPENDED_GRACE_DAYS,
      );
      if (now > gracePeriodEnd) {
        targetStatus = 'SUSPENDED';
        reason = `미결제 유예기간(${this.SUSPENDED_GRACE_DAYS}일) 초과 (자동)`;
      }
    }

    if (targetStatus) {
      // 상태 머신 전이 검증 후 전이
      const allowed = VALID_TRANSITIONS[currentStatus];
      if (allowed && allowed.includes(targetStatus)) {
        await this.prisma.subscription.update({
          where: { id: subscriptionId },
          data: { status: targetStatus },
        });
        await this.recordTransitionAudit(
          subscription.siteId,
          subscriptionId,
          currentStatus,
          targetStatus,
          reason,
        );
        this.logger.log(
          `Subscription ${subscriptionId} auto-transition: ${currentStatus} → ${targetStatus}`,
        );
        return targetStatus;
      }
    }

    return subscription.status;
  }

  // ──────────────────────────────────────────────
  // 현재 사이트 구독 상태 조회
  // ──────────────────────────────────────────────
  async getSubscription(siteId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      // 구독이 없으면 Free 플랜 정보를 반환
      const freePlan = await this.prisma.plan.findUnique({
        where: { code: 'FREE' },
      });

      return {
        subscription: null,
        currentPlan: freePlan,
        status: 'FREE',
      };
    }

    // 매번 만료 체크 실행
    const effectiveStatus = await this.checkSubscriptionStatus(
      subscription.id,
    );

    return {
      subscription: {
        ...subscription,
        status: effectiveStatus,
      },
      currentPlan: subscription.plan,
      status: effectiveStatus,
    };
  }

  // ──────────────────────────────────────────────
  // 현재 플랜 + 구독 상태 (billing/current-plan)
  // ──────────────────────────────────────────────
  async getCurrentPlan(siteId: string) {
    const result = await this.getSubscription(siteId);

    return {
      plan: result.currentPlan,
      subscription: result.subscription
        ? {
            id: result.subscription.id,
            status: result.status,
            billingCycle: result.subscription.billingCycle,
            trialEndsAt: result.subscription.trialEndsAt,
            currentPeriodStart: result.subscription.currentPeriodStart,
            currentPeriodEnd: result.subscription.currentPeriodEnd,
          }
        : null,
      status: result.status,
    };
  }

  // ──────────────────────────────────────────────
  // 접근 가능한 기능 목록 (billing/feature-access)
  // ──────────────────────────────────────────────
  async getFeatureAccess(siteId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      // Free 플랜의 features 반환
      const freePlan = await this.prisma.plan.findUnique({
        where: { code: 'FREE' },
      });
      return {
        planCode: 'FREE',
        planName: freePlan?.name ?? 'Free',
        features: freePlan?.features ?? [],
        status: 'FREE',
      };
    }

    // 만료 체크
    const effectiveStatus = await this.checkSubscriptionStatus(
      subscription.id,
    );

    const isAccessible = ['ACTIVE', 'TRIAL'].includes(
      effectiveStatus ?? subscription.status,
    );

    return {
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      features: isAccessible ? subscription.plan.features : [],
      status: effectiveStatus ?? subscription.status,
    };
  }

  // ──────────────────────────────────────────────
  // [MASTER] 전체 사업장 구독 현황 목록
  // ──────────────────────────────────────────────
  async getAllSubscriptions() {
    const sites = await this.prisma.site.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    const [subscriptions, workerCounts] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { siteId: { in: sites.map((s) => s.id) } },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.worker.groupBy({
        by: ['siteId'],
        where: {
          siteId: { in: sites.map((s) => s.id) },
          status: 'ACTIVE',
          role: { notIn: ['MASTER', 'ADMIN'] },
        },
        _count: { id: true },
      }),
    ]);

    // Build lookup maps
    const subBySite = new Map<string, typeof subscriptions[0]>();
    for (const sub of subscriptions) {
      if (sub.siteId && !subBySite.has(sub.siteId)) {
        subBySite.set(sub.siteId, sub);
      }
    }

    const countBySite = new Map<string, number>();
    for (const wc of workerCounts) {
      if (wc.siteId) countBySite.set(wc.siteId, wc._count.id);
    }

    return sites.map((site) => {
      const sub = subBySite.get(site.id);
      return {
        siteId: site.id,
        siteName: site.name,
        siteCode: site.code,
        planName: sub?.plan?.name || 'Free',
        planCode: sub?.plan?.code || 'FREE',
        status: sub?.status || 'FREE',
        trialEndsAt: sub?.trialEndsAt || null,
        currentPeriodEnd: sub?.currentPeriodEnd || null,
        workerCount: countBySite.get(site.id) || 0,
      };
    });
  }

  // ──────────────────────────────────────────────
  // [MASTER] 사업장 플랜 변경
  // ──────────────────────────────────────────────
  async changePlan(siteId: string, planCode: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
    }

    // FREE로 변경: 기존 구독 삭제
    if (planCode === 'FREE') {
      await this.prisma.subscription.deleteMany({ where: { siteId } });
      return { message: `${site.name} 사업장이 Free 플랜으로 변경되었습니다` };
    }

    // BASIC/PRO로 변경
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) {
      throw new NotFoundException(`플랜을 찾을 수 없습니다: ${planCode}`);
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    // 기존 구독이 있으면 업데이트, 없으면 생성
    const existing = await this.prisma.subscription.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      await this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          planId: plan.id,
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          trialEndsAt: null,
        },
      });
    } else {
      await this.prisma.subscription.create({
        data: {
          siteId,
          planId: plan.id,
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });
    }

    return { message: `${site.name} 사업장이 ${plan.name} 플랜으로 변경되었습니다` };
  }

  // ──────────────────────────────────────────────
  // [MASTER] 구독 활성화 (입금 확인 후)
  // ──────────────────────────────────────────────
  async activateSubscription(siteId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });

    if (!subscription) {
      throw new NotFoundException('해당 사업장의 구독을 찾을 수 없습니다');
    }

    if (subscription.status === 'ACTIVE') {
      throw new BadRequestException('이미 활성 상태입니다');
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    return { message: `${subscription.plan.name} 구독이 활성화되었습니다` };
  }

  // ──────────────────────────────────────────────
  // [MASTER] 구독 해지
  // ──────────────────────────────────────────────
  async cancelSubscription(siteId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });

    if (!subscription) {
      throw new NotFoundException('해당 사업장의 구독을 찾을 수 없습니다');
    }

    if (subscription.status === 'CANCELLED') {
      throw new BadRequestException('이미 해지된 구독입니다');
    }

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELLED' },
    });

    return { message: `${subscription.plan.name} 구독이 해지되었습니다` };
  }

  // ──────────────────────────────────────────────
  // [MASTER] 무료 체험 부여
  // ──────────────────────────────────────────────
  async grantTrial(siteId: string, days: number = 14) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
    }

    // 이미 활성 구독/체험이 있으면 에러
    const existing = await this.prisma.subscription.findFirst({
      where: { siteId, status: { in: ['ACTIVE', 'TRIAL'] } },
    });
    if (existing) {
      throw new BadRequestException('이미 활성화된 구독 또는 체험이 있습니다');
    }

    // BASIC 플랜으로 체험 부여
    const plan = await this.prisma.plan.findUnique({ where: { code: 'BASIC' } });
    if (!plan) {
      throw new NotFoundException('BASIC 플랜을 찾을 수 없습니다');
    }

    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + days);

    // 기존 만료/해지 구독 삭제 후 새로 생성
    await this.prisma.subscription.deleteMany({
      where: { siteId, status: { in: ['EXPIRED', 'CANCELLED', 'SUSPENDED'] } },
    });

    await this.prisma.subscription.create({
      data: {
        siteId,
        planId: plan.id,
        status: 'TRIAL',
        billingCycle: 'MONTHLY',
        trialEndsAt: trialEnd,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
      },
    });

    return {
      message: `${site.name} 사업장에 ${days}일 무료 체험이 부여되었습니다`,
      trialEndsAt: trialEnd,
    };
  }

  // ──────────────────────────────────────────────
  // 14일 무료 체험 시작
  // ──────────────────────────────────────────────
  async startTrial(siteId: string, planCode: string = 'BASIC') {
    // 1. 사업장 존재 확인
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
    });
    if (!site) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
    }

    // 2. 이미 구독/체험 중인지 확인
    const existing = await this.prisma.subscription.findFirst({
      where: {
        siteId,
        status: { in: ['ACTIVE', 'TRIAL'] },
      },
    });
    if (existing) {
      throw new BadRequestException(
        '이미 활성화된 구독 또는 체험이 있습니다',
      );
    }

    // 3. 이전에 체험을 사용한 적이 있는지 확인 (1회 제한)
    const previousTrial = await this.prisma.subscription.findFirst({
      where: {
        siteId,
        status: { in: ['EXPIRED', 'CANCELLED'] },
        trialEndsAt: { not: null },
      },
    });
    if (previousTrial) {
      throw new ForbiddenException(
        '무료 체험은 사업장당 1회만 가능합니다',
      );
    }

    // 4. 플랜 조회
    const plan = await this.prisma.plan.findUnique({
      where: { code: planCode },
    });
    if (!plan) {
      throw new NotFoundException(`플랜을 찾을 수 없습니다: ${planCode}`);
    }
    if (plan.code === 'FREE') {
      throw new BadRequestException(
        'Free 플랜은 무료 체험 대상이 아닙니다',
      );
    }

    // 5. 구독 생성 (14일 체험)
    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + this.TRIAL_DAYS);

    const subscription = await this.prisma.subscription.create({
      data: {
        siteId,
        planId: plan.id,
        status: 'TRIAL',
        billingCycle: 'MONTHLY',
        trialEndsAt: trialEnd,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
      },
      include: { plan: true },
    });

    return {
      subscription,
      message: `${plan.name} 플랜 ${this.TRIAL_DAYS}일 무료 체험이 시작되었습니다`,
      trialEndsAt: trialEnd,
    };
  }

  // ══════════════════════════════════════════════
  // 구독 상태 전이 (State Machine)
  // ══════════════════════════════════════════════

  /**
   * 구독 상태를 전이하고 감사 로그를 기록합니다.
   * VALID_TRANSITIONS 맵에 정의된 전이만 허용됩니다.
   *
   * @param subscriptionId 구독 ID
   * @param newStatus      전이할 상태
   * @param reason         전이 사유 (감사 로그용)
   * @param actorId        전이 수행자 ID (수동 전이 시)
   */
  async transitionStatus(
    subscriptionId: string,
    newStatus: SubscriptionStatus,
    reason: string,
    actorId?: string,
  ) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { site: { select: { name: true } } },
    });

    if (!subscription) {
      throw new NotFoundException('구독을 찾을 수 없습니다');
    }

    const currentStatus = subscription.status as SubscriptionStatus;

    // 현재 상태가 유효한 상태인지 확인
    if (!VALID_TRANSITIONS[currentStatus]) {
      throw new BadRequestException(
        `알 수 없는 현재 상태입니다: ${currentStatus}`,
      );
    }

    // 전이가 허용되는지 확인
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `상태 전이가 허용되지 않습니다: ${currentStatus} → ${newStatus}. ` +
        `허용된 전이: ${allowed.length > 0 ? allowed.join(', ') : '없음 (최종 상태)'}`,
      );
    }

    // 상태 전이 실행
    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: newStatus },
      include: { plan: true },
    });

    // 감사 로그 기록 (AdminActivityLog 활용)
    await this.recordTransitionAudit(
      subscription.siteId,
      subscriptionId,
      currentStatus,
      newStatus,
      reason,
      actorId,
    );

    this.logger.log(
      `Subscription ${subscriptionId} (${subscription.site?.name || 'unknown'}): ` +
      `${currentStatus} → ${newStatus} [${reason}]`,
    );

    return {
      subscription: updated,
      previousStatus: currentStatus,
      newStatus,
      message: `구독 상태가 ${currentStatus}에서 ${newStatus}로 변경되었습니다`,
    };
  }

  /**
   * 만료된 체험 구독을 일괄 처리합니다.
   * TRIAL 상태이고 trialEndsAt이 지난 구독을 EXPIRED로 전이합니다.
   *
   * @returns 처리된 구독 수
   */
  async checkTrialExpirations(): Promise<{
    processed: number;
    expired: string[];
  }> {
    const now = new Date();

    const expiredTrials = await this.prisma.subscription.findMany({
      where: {
        status: 'TRIAL',
        trialEndsAt: { lt: now },
      },
      include: { site: { select: { name: true } } },
    });

    const expired: string[] = [];

    for (const trial of expiredTrials) {
      try {
        await this.transitionStatus(
          trial.id,
          'EXPIRED',
          '체험 기간 만료 (자동 처리)',
        );
        expired.push(
          `${trial.site?.name || trial.siteId} (${trial.id})`,
        );
      } catch (err) {
        this.logger.error(
          `체험 만료 처리 실패: ${trial.id} - ${err}`,
        );
      }
    }

    if (expired.length > 0) {
      this.logger.log(
        `체험 만료 일괄 처리 완료: ${expired.length}건`,
      );
    }

    return { processed: expired.length, expired };
  }

  /**
   * PAST_DUE 상태가 유예 기간(30일)을 초과한 구독을 SUSPENDED로 전이합니다.
   *
   * @returns 처리된 구독 수
   */
  async checkPastDueSuspensions(): Promise<{
    processed: number;
    suspended: string[];
  }> {
    const now = new Date();

    const pastDueSubscriptions = await this.prisma.subscription.findMany({
      where: { status: 'PAST_DUE' },
      include: { site: { select: { name: true } } },
    });

    const suspended: string[] = [];

    for (const sub of pastDueSubscriptions) {
      const gracePeriodEnd = new Date(sub.currentPeriodEnd);
      gracePeriodEnd.setDate(
        gracePeriodEnd.getDate() + this.SUSPENDED_GRACE_DAYS,
      );

      if (now > gracePeriodEnd) {
        try {
          await this.transitionStatus(
            sub.id,
            'SUSPENDED',
            `미결제 유예기간(${this.SUSPENDED_GRACE_DAYS}일) 초과 (자동 처리)`,
          );
          suspended.push(
            `${sub.site?.name || sub.siteId} (${sub.id})`,
          );
        } catch (err) {
          this.logger.error(
            `PAST_DUE → SUSPENDED 처리 실패: ${sub.id} - ${err}`,
          );
        }
      }
    }

    if (suspended.length > 0) {
      this.logger.log(
        `PAST_DUE → SUSPENDED 일괄 처리 완료: ${suspended.length}건`,
      );
    }

    return { processed: suspended.length, suspended };
  }

  /**
   * 결제 기간이 만료된 ACTIVE 구독을 PAST_DUE로 전이합니다.
   * (기존엔 조회 시점(checkSubscriptionStatus)에만 전이돼 미납이 자동 진행되지 않던 문제 — 개통 분석 P1-5a)
   *
   * @returns 처리된 구독 수
   */
  async checkActivePastDue(): Promise<{
    processed: number;
    pastDue: string[];
  }> {
    const now = new Date();

    const expiredActive = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', currentPeriodEnd: { lt: now } },
      include: { site: { select: { name: true } } },
    });

    const pastDue: string[] = [];

    for (const sub of expiredActive) {
      try {
        await this.transitionStatus(
          sub.id,
          'PAST_DUE',
          '결제 기간 만료 (자동 처리)',
        );
        pastDue.push(`${sub.site?.name || sub.siteId} (${sub.id})`);
      } catch (err) {
        this.logger.error(`ACTIVE → PAST_DUE 처리 실패: ${sub.id} - ${err}`);
      }
    }

    if (pastDue.length > 0) {
      this.logger.log(`ACTIVE → PAST_DUE 일괄 처리 완료: ${pastDue.length}건`);
    }

    return { processed: pastDue.length, pastDue };
  }

  // ══════════════════════════════════════════════
  // #17 구독 만료 D-day 알림 (subscription-check 크론에서 호출)
  // ══════════════════════════════════════════════

  /**
   * 만료가 임박한 구독을 센터 담당자에게 메일로 안내하고,
   * 이번 주(7일) 내 만료 예정 목록을 MASTER 에게 1통으로 요약 발송합니다.
   *
   * 발송 기준 (모두 KST 날짜 정확 매칭 → 별도 마커 없이 하루 1회 멱등):
   *   (a) TRIAL    : trialEndsAt 이 오늘 기준 D-7 / D-3 / D-1
   *   (b) ACTIVE   : currentPeriodEnd 가 D-7 → 결제 안내
   *   (c) PAST_DUE : 유예 종료일(currentPeriodEnd + 30일, checkPastDueSuspensions 와 동일 계산) 이 D-3 → 정지 예정 안내
   *   (d) MASTER   : 오늘~7일 내 만료 예정 건 목록 (0건이면 미발송)
   *
   * - 대상 사이트: 최상위(parentSiteId null) 활성 사이트, 사이트당 최신 구독 1건
   * - 수신자: NotificationsService.resolveRecipients(siteId, 'subscription') — 없으면 skip (MASTER 폴백 없음)
   * - 사이트별 try/catch: 한 센터 실패가 나머지를 막지 않음. 이 메서드는 throw 하지 않음
   *   (runCronJob 재시도 시 중복 발송 방지 — 호출 측에서는 다른 전이 작업 뒤 마지막에 호출 권장)
   */
  async notifyUpcomingExpirations(): Promise<{
    sent: number;
    skipped: number;
    errors: string[];
  }> {
    const result = { sent: 0, skipped: 0, errors: [] as string[] };
    const todayKey = this.kstDateKey(new Date());

    // 1) 후보 구독 조회 (TRIAL / ACTIVE / PAST_DUE)
    let subscriptions: ExpiryCandidate[];
    try {
      subscriptions = await this.prisma.subscription.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
        include: {
          site: {
            select: {
              id: true,
              name: true,
              code: true,
              isActive: true,
              parentSiteId: true,
            },
          },
          plan: {
            select: {
              name: true,
              code: true,
              priceMonthly: true,
              maxWorkers: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (err) {
      const msg = `구독 만료 알림: 구독 목록 조회 실패 — ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(msg);
      result.errors.push(msg);
      return result;
    }

    // 2) 최상위 활성 사이트만 + 사이트당 최신 1건 (createdAt desc 정렬이므로 첫 항목이 최신)
    const latestBySite = new Map<string, ExpiryCandidate>();
    for (const sub of subscriptions) {
      if (!sub.site || !sub.site.isActive || sub.site.parentSiteId) continue;
      if (!latestBySite.has(sub.siteId)) latestBySite.set(sub.siteId, sub);
    }

    // 3) 플랜 안내표 (체험 만료 메일용) — 1회만 조회, 실패해도 알림 자체는 진행
    let plans: PlanSummary[] = [];
    try {
      plans = await this.prisma.plan.findMany({
        where: { isActive: true, code: { not: 'FREE' } },
        select: { name: true, code: true, priceMonthly: true, maxWorkers: true },
        orderBy: { priceMonthly: 'asc' },
      });
    } catch (err) {
      this.logger.warn(`구독 만료 알림: 플랜 목록 조회 실패 (플랜 안내 생략) — ${err}`);
    }

    // 4) 센터별 발송 (사이트별 try/catch)
    const digestItems: ExpiryDigestItem[] = [];

    for (const sub of latestBySite.values()) {
      const siteName = sub.site?.name || sub.siteId;
      try {
        const target = this.resolveExpiryTarget(sub);
        if (!target) continue;

        const daysLeft = this.kstDaysBetween(todayKey, target.dateKey);
        const status = sub.status as SubscriptionStatus;
        const noticeDays =
          status === 'TRIAL'
            ? this.TRIAL_NOTICE_DAYS
            : status === 'ACTIVE'
              ? this.ACTIVE_NOTICE_DAYS
              : this.PAST_DUE_NOTICE_DAYS;

        const digestItem: ExpiryDigestItem | null =
          daysLeft >= 0 && daysLeft <= this.MASTER_DIGEST_WINDOW_DAYS
            ? {
                siteName,
                siteCode: sub.site?.code || '-',
                status,
                planName: sub.plan?.name || '-',
                dateKey: target.dateKey,
                daysLeft,
                noticeOutcome: '해당 없음',
              }
            : null;
        if (digestItem) digestItems.push(digestItem);

        // 발송 시점 정확 매칭 (오늘 KST 날짜 == 목표일) — 하루 1회 멱등
        if (!noticeDays.includes(daysLeft)) continue;

        const recipients = await this.notifications.resolveRecipients(
          sub.siteId,
          'subscription',
        );
        if (recipients.length === 0) {
          result.skipped++;
          if (digestItem) digestItem.noticeOutcome = '수신자 없음';
          this.logger.warn(
            `구독 만료 알림 스킵(수신자 없음): ${siteName} [${status} D-${daysLeft}]`,
          );
          continue;
        }

        const mail = this.buildExpiryNoticeMail(sub, status, daysLeft, target, plans);
        const sendResult = await this.notifications.sendMail({
          to: recipients,
          subject: mail.subject,
          html: mail.html,
        });

        if (sendResult.ok) {
          result.sent++;
          if (digestItem) digestItem.noticeOutcome = `발송 (D-${daysLeft})`;
          this.logger.log(
            `구독 만료 알림 발송: ${siteName} [${status} D-${daysLeft}] → ${recipients.length}명`,
          );
        } else if (sendResult.error === 'no-api-key') {
          result.skipped++;
          if (digestItem) digestItem.noticeOutcome = '미발송 (메일 미설정)';
        } else {
          result.errors.push(
            `${siteName}: 메일 발송 실패 (${sendResult.error || 'unknown'})`,
          );
          if (digestItem) digestItem.noticeOutcome = '발송 실패';
        }
      } catch (err) {
        const msg = `${siteName}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(`구독 만료 알림 처리 실패 — ${msg}`);
        result.errors.push(msg);
      }
    }

    // 5) MASTER 다이제스트 — 항목이 있을 때만, 마지막에 1통
    if (digestItems.length > 0) {
      try {
        digestItems.sort((a, b) => a.daysLeft - b.daysLeft);
        const digest = this.buildMasterDigestMail(todayKey, digestItems);
        const sendResult = await this.notifications.sendMail({
          to: this.notifications.masterEmail(),
          subject: digest.subject,
          html: digest.html,
        });
        if (sendResult.ok) {
          result.sent++;
          this.logger.log(`구독 만료 MASTER 다이제스트 발송: ${digestItems.length}건`);
        } else if (sendResult.error === 'no-api-key') {
          result.skipped++;
        } else {
          result.errors.push(
            `MASTER 다이제스트 발송 실패 (${sendResult.error || 'unknown'})`,
          );
        }
      } catch (err) {
        const msg = `MASTER 다이제스트: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(`구독 만료 알림 — ${msg}`);
        result.errors.push(msg);
      }
    }

    this.logger.log(
      `구독 만료 D-day 알림 완료: sent=${result.sent}, skipped=${result.skipped}, errors=${result.errors.length}`,
    );
    return result;
  }

  /**
   * 상태별 "만료 기준일" (KST 날짜 키) 계산
   *  - TRIAL    → trialEndsAt (없으면 null)
   *  - ACTIVE   → currentPeriodEnd
   *  - PAST_DUE → currentPeriodEnd + SUSPENDED_GRACE_DAYS (checkPastDueSuspensions 와 동일 계산)
   */
  private resolveExpiryTarget(
    sub: ExpiryCandidate,
  ): { dateKey: string; date: Date } | null {
    switch (sub.status) {
      case 'TRIAL': {
        if (!sub.trialEndsAt) return null;
        const d = new Date(sub.trialEndsAt);
        return { dateKey: this.kstDateKey(d), date: d };
      }
      case 'ACTIVE': {
        const d = new Date(sub.currentPeriodEnd);
        return { dateKey: this.kstDateKey(d), date: d };
      }
      case 'PAST_DUE': {
        const gracePeriodEnd = new Date(sub.currentPeriodEnd);
        gracePeriodEnd.setDate(
          gracePeriodEnd.getDate() + this.SUSPENDED_GRACE_DAYS,
        );
        return { dateKey: this.kstDateKey(gracePeriodEnd), date: gracePeriodEnd };
      }
      default:
        return null;
    }
  }

  /** 센터 담당자용 안내 메일 (TRIAL / ACTIVE / PAST_DUE) */
  private buildExpiryNoticeMail(
    sub: ExpiryCandidate,
    status: SubscriptionStatus,
    daysLeft: number,
    target: { dateKey: string; date: Date },
    plans: PlanSummary[],
  ): { subject: string; html: string } {
    const siteName = sub.site?.name || sub.siteId;
    const safeSite = this.escapeHtml(siteName);
    const planName = this.escapeHtml(sub.plan?.name || '-');
    const priceMonthly = Number(sub.plan?.priceMonthly ?? 0);
    const contactEmail = this.notifications.masterEmail();
    const billingUrl = `${process.env.WEB_BASE_URL || 'https://sae-work.com'}/billing`;
    const targetDateKo = this.formatKstDate(target.dateKey);

    let subject: string;
    let title: string;
    let accent: string;
    let bg: string;
    let intro: string;
    let rows: Array<[string, string]>;
    let notice: string;

    if (status === 'TRIAL') {
      subject = `[새롬GLS][${siteName}] 무료 체험 ${daysLeft}일 남음`;
      title = `무료 체험 종료 ${daysLeft}일 전`;
      accent = '#2C6FB0';
      bg = '#EFF6FF';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 무료 체험이 <b>${daysLeft}일</b> 후 종료됩니다.`;
      rows = [
        ['사업장', safeSite],
        ['현재 플랜', `${planName} (무료 체험)`],
        ['체험 종료일', `${targetDateKo} (KST)`],
        ['남은 기간', `${daysLeft}일`],
      ];
      notice =
        '체험 종료 후에는 작업 기록 조회·관리 기능 이용이 제한됩니다. ' +
        '계속 이용하시려면 종료일 전에 아래 플랜 중 하나를 선택해 주세요.';
    } else if (status === 'ACTIVE') {
      subject = `[새롬GLS][${siteName}] 구독 결제 안내 — ${daysLeft}일 후 이용기간 종료`;
      title = `구독 결제 안내 (D-${daysLeft})`;
      accent = '#D97706';
      bg = '#FFFBEB';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 이용기간이 <b>${daysLeft}일</b> 후 종료됩니다.`;
      rows = [
        ['사업장', safeSite],
        ['현재 플랜', planName],
        ['이용기간 종료일', `${targetDateKo} (KST)`],
        ['월 요금', priceMonthly > 0 ? `${priceMonthly.toLocaleString('ko-KR')}원 (VAT 별도)` : '-'],
      ];
      notice =
        `종료일까지 결제가 확인되지 않으면 미결제 상태로 전환되며, ` +
        `유예기간 ${this.SUSPENDED_GRACE_DAYS}일 이후 서비스가 정지됩니다. ` +
        '입금 후 아래 문의처로 알려주시면 확인 즉시 다음 이용기간이 반영됩니다.';
    } else {
      subject = `[새롬GLS][${siteName}] 미결제 안내 — ${daysLeft}일 후 서비스 정지 예정`;
      title = `서비스 정지 예정 (D-${daysLeft})`;
      accent = '#DC2626';
      bg = '#FEF2F2';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 결제가 확인되지 않아 <b>${daysLeft}일</b> 후 서비스가 정지될 예정입니다.`;
      rows = [
        ['사업장', safeSite],
        ['현재 플랜', planName],
        ['이용기간 종료일', `${this.formatKstDate(this.kstDateKey(new Date(sub.currentPeriodEnd)))} (KST)`],
        ['정지 예정일', `${targetDateKo} (KST)`],
        ['월 요금', priceMonthly > 0 ? `${priceMonthly.toLocaleString('ko-KR')}원 (VAT 별도)` : '-'],
      ];
      notice =
        '정지 예정일이 지나면 작업 기록 조회·관리 기능 이용이 제한됩니다. ' +
        '입금 후 아래 문의처로 알려주시면 확인 즉시 정상 이용으로 복구됩니다.';
    }

    const infoTable = rows
      .map(
        ([k, v]) =>
          `<tr>
            <td style="padding:8px 12px;border:1px solid #E2E8F0;background:#F8FAFC;color:#475569;font-size:13px;white-space:nowrap;">${k}</td>
            <td style="padding:8px 12px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;">${v}</td>
          </tr>`,
      )
      .join('');

    const planTable =
      status === 'TRIAL' && plans.length > 0
        ? `
          <h3 style="color:#0F172A;font-size:15px;margin:24px 0 8px;">이용 가능한 플랜</h3>
          <table style="border-collapse:collapse;width:100%;">
            <tr>
              <th style="padding:8px 12px;border:1px solid #E2E8F0;background:#F1F5F9;color:#475569;font-size:13px;text-align:left;">플랜</th>
              <th style="padding:8px 12px;border:1px solid #E2E8F0;background:#F1F5F9;color:#475569;font-size:13px;text-align:right;">작업자 상한</th>
              <th style="padding:8px 12px;border:1px solid #E2E8F0;background:#F1F5F9;color:#475569;font-size:13px;text-align:right;">월 요금</th>
            </tr>
            ${plans
              .map(
                (p) => `<tr>
                  <td style="padding:8px 12px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;">${this.escapeHtml(p.name)}${p.code === sub.plan?.code ? ' <span style="color:#2C6FB0;font-size:12px;">(체험 중)</span>' : ''}</td>
                  <td style="padding:8px 12px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;text-align:right;">${Number(p.maxWorkers)}명</td>
                  <td style="padding:8px 12px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;text-align:right;">${Number(p.priceMonthly).toLocaleString('ko-KR')}원</td>
                </tr>`,
              )
              .join('')}
          </table>
          <p style="color:#94A3B8;font-size:12px;margin:6px 0 0;">요금은 VAT 별도이며, 세금계산서 발행이 가능합니다.</p>`
        : '';

    const html = `
      <div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <div style="background:${bg};border-left:4px solid ${accent};padding:16px;border-radius:8px;margin-bottom:20px;">
          <h2 style="color:${accent};margin:0 0 6px;font-size:18px;">${title}</h2>
          <p style="color:#334155;margin:0;font-size:14px;line-height:1.6;">${intro}</p>
        </div>
        <table style="border-collapse:collapse;width:100%;">${infoTable}</table>
        <p style="color:#475569;font-size:13px;line-height:1.7;margin:16px 0 0;">${notice}</p>
        ${planTable}
        <div style="margin:24px 0 0;padding:14px 16px;background:#F8FAFC;border-radius:8px;">
          <p style="color:#0F172A;font-size:13px;margin:0 0 6px;"><b>문의 · 결제 안내</b></p>
          <p style="color:#475569;font-size:13px;line-height:1.7;margin:0;">
            이메일: <a href="mailto:${contactEmail}" style="color:#2C6FB0;">${contactEmail}</a><br>
            구독 현황: <a href="${billingUrl}" style="color:#2C6FB0;">${billingUrl}</a>
          </p>
        </div>
        <p style="color:#CBD5E1;font-size:11px;margin-top:24px;text-align:center;">
          본 메일은 새롬 GLS 작업현황 공유 시스템에서 자동 발송되었습니다.
        </p>
      </div>
    `;

    return { subject, html };
  }

  /** MASTER 운영자용 이번 주 만료 예정 다이제스트 */
  private buildMasterDigestMail(
    todayKey: string,
    items: ExpiryDigestItem[],
  ): { subject: string; html: string } {
    const statusLabel: Record<string, string> = {
      TRIAL: '무료 체험',
      ACTIVE: '이용 중',
      PAST_DUE: '미결제(유예)',
    };
    const statusColor: Record<string, string> = {
      TRIAL: '#2C6FB0',
      ACTIVE: '#D97706',
      PAST_DUE: '#DC2626',
    };
    const th = (label: string, align = 'left') =>
      `<th style="padding:8px 10px;border:1px solid #E2E8F0;background:#F1F5F9;color:#475569;font-size:12px;text-align:${align};white-space:nowrap;">${label}</th>`;
    const td = (v: string, align = 'left') =>
      `<td style="padding:8px 10px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;text-align:${align};">${v}</td>`;

    const rowsHtml = items
      .map((it) => {
        const color = statusColor[it.status] || '#475569';
        const dday = it.daysLeft === 0 ? '<b style="color:#DC2626;">D-day</b>' : `D-${it.daysLeft}`;
        return `<tr>
          ${td(`${this.escapeHtml(it.siteName)} <span style="color:#94A3B8;font-size:11px;">(${this.escapeHtml(it.siteCode)})</span>`)}
          ${td(`<span style="color:${color};font-weight:600;">${statusLabel[it.status] || it.status}</span>`)}
          ${td(this.escapeHtml(it.planName))}
          ${td(this.formatKstDate(it.dateKey), 'center')}
          ${td(dday, 'center')}
          ${td(this.escapeHtml(it.noticeOutcome), 'center')}
        </tr>`;
      })
      .join('');

    const subject = `[새롬GLS][운영] 이번 주 만료 예정 구독 ${items.length}건 (${todayKey})`;
    const html = `
      <div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:720px;margin:0 auto;padding:24px;">
        <h2 style="color:#0F172A;margin:0 0 4px;font-size:18px;">구독 만료 예정 다이제스트</h2>
        <p style="color:#64748B;font-size:13px;margin:0 0 16px;">
          기준일 ${this.formatKstDate(todayKey)} (KST) · 오늘부터 ${this.MASTER_DIGEST_WINDOW_DAYS}일 이내 만료 예정 ${items.length}건
        </p>
        <div style="overflow-x:auto;">
          <table style="border-collapse:collapse;width:100%;">
            <tr>
              ${th('사업장')}${th('상태')}${th('플랜')}${th('만료 예정일', 'center')}${th('D-day', 'center')}${th('오늘 고객 발송', 'center')}
            </tr>
            ${rowsHtml}
          </table>
        </div>
        <p style="color:#94A3B8;font-size:12px;line-height:1.7;margin:16px 0 0;">
          · 만료 예정일: 무료 체험=체험 종료일, 이용 중=이용기간 종료일, 미결제=유예 종료(정지 예정)일<br>
          · 고객 발송은 체험 D-7/D-3/D-1, 이용 중 D-7, 미결제 D-3 에만 이루어집니다.
        </p>
        <p style="color:#CBD5E1;font-size:11px;margin-top:24px;text-align:center;">
          본 메일은 새롬 GLS 작업현황 공유 시스템에서 자동 발송되었습니다.
        </p>
      </div>
    `;

    return { subject, html };
  }

  // ── KST 날짜 유틸 (알림 전용) ──

  /** Date → KST 기준 'YYYY-MM-DD' */
  private kstDateKey(d: Date): string {
    return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** 'YYYY-MM-DD' 두 날짜 키의 차이(일) — toKey - fromKey */
  private kstDaysBetween(fromKey: string, toKey: string): number {
    const [fy, fm, fd] = fromKey.split('-').map(Number);
    const [ty, tm, tdd] = toKey.split('-').map(Number);
    const from = Date.UTC(fy, fm - 1, fd);
    const to = Date.UTC(ty, tm - 1, tdd);
    return Math.round((to - from) / (24 * 60 * 60 * 1000));
  }

  /** 'YYYY-MM-DD' → 'YYYY년 M월 D일 (요일)' */
  private formatKstDate(key: string): string {
    const [y, m, d] = key.split('-').map(Number);
    if (!y || !m || !d) return key;
    const weekday = ['일', '월', '화', '수', '목', '금', '토'][
      new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    ];
    return `${y}년 ${m}월 ${d}일 (${weekday})`;
  }

  private escapeHtml(value: string): string {
    return String(value ?? '').replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
    );
  }

  // ──────────────────────────────────────────────
  // 감사 로그 기록 (구독 상태 전이)
  // ──────────────────────────────────────────────
  private async recordTransitionAudit(
    siteId: string,
    subscriptionId: string,
    fromStatus: string,
    toStatus: string,
    reason: string,
    actorId?: string,
  ) {
    try {
      await this.prisma.adminActivityLog.create({
        data: {
          siteId,
          actorWorkerId: actorId || 'SYSTEM',
          actionType: 'SUBSCRIPTION_TRANSITION',
          targetType: 'SUBSCRIPTION',
          targetId: subscriptionId,
          metadata: JSON.stringify({
            fromStatus,
            toStatus,
            reason,
            timestamp: new Date().toISOString(),
          }),
        },
      });
    } catch (err) {
      // 감사 로그 실패가 전이 자체를 막지 않도록 함
      this.logger.error(`구독 전이 감사 로그 기록 실패: ${err}`);
    }
  }
}
