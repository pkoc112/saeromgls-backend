import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  /** 무료 체험 기간 (일) */
  private readonly TRIAL_DAYS = 14;

  /** PAST_DUE 상태 유지 최대 일수 (초과 시 SUSPENDED) */
  private readonly PAST_DUE_GRACE_DAYS = 7;

  /** PAST_DUE → SUSPENDED 까지의 유예 일수 */
  private readonly SUSPENDED_GRACE_DAYS = 30;

  constructor(private readonly prisma: PrismaService) {}

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

    if (subscription.status === 'CANCELED') {
      throw new BadRequestException('이미 해지된 구독입니다');
    }

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED' },
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
      where: { siteId, status: { in: ['EXPIRED', 'CANCELED', 'SUSPENDED'] } },
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
