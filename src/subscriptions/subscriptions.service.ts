import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  /** 무료 체험 기간 (일) */
  private readonly TRIAL_DAYS = 14;

  /** PAST_DUE 상태 유지 최대 일수 (초과 시 SUSPENDED) */
  private readonly PAST_DUE_GRACE_DAYS = 7;

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
  // 구독 상태 자동 전이 체크
  // TRIAL → (14일 후) → EXPIRED
  // ACTIVE → (기간 만료) → PAST_DUE → (7일) → SUSPENDED
  // ──────────────────────────────────────────────
  async checkSubscriptionStatus(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!subscription) return null;

    const now = new Date();
    let newStatus: string | null = null;

    // TRIAL → EXPIRED
    if (
      subscription.status === 'TRIAL' &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt < now
    ) {
      newStatus = 'EXPIRED';
    }

    // ACTIVE → PAST_DUE (기간 만료 시)
    if (
      subscription.status === 'ACTIVE' &&
      subscription.currentPeriodEnd < now
    ) {
      newStatus = 'PAST_DUE';
    }

    // PAST_DUE → SUSPENDED (7일 유예 초과)
    if (subscription.status === 'PAST_DUE') {
      const gracePeriodEnd = new Date(subscription.currentPeriodEnd);
      gracePeriodEnd.setDate(
        gracePeriodEnd.getDate() + this.PAST_DUE_GRACE_DAYS,
      );
      if (now > gracePeriodEnd) {
        newStatus = 'SUSPENDED';
      }
    }

    if (newStatus) {
      this.logger.log(
        `Subscription ${subscriptionId} status transition: ${subscription.status} → ${newStatus}`,
      );
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { status: newStatus },
      });
      return newStatus;
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
}
