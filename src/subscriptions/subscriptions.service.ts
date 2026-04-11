import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionsService {
  /** 무료 체험 기간 (일) */
  private readonly TRIAL_DAYS = 14;

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

    // 만료 여부 체크
    const now = new Date();
    let effectiveStatus = subscription.status;

    if (
      subscription.status === 'TRIAL' &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt < now
    ) {
      effectiveStatus = 'EXPIRED';
      // DB 상태도 업데이트
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      });
    }

    if (
      subscription.status === 'ACTIVE' &&
      subscription.currentPeriodEnd < now
    ) {
      effectiveStatus = 'EXPIRED';
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'EXPIRED' },
      });
    }

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
