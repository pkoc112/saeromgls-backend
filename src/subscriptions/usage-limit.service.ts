import {
  Injectable,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBillingSiteId } from '../common/utils/billing-site';

@Injectable()
export class UsageLimitService {
  private readonly logger = new Logger(UsageLimitService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 해당 사업장에 작업자를 추가할 수 있는지 확인
   * 현재 작업자 수 vs Plan.maxWorkers
   */
  async canAddWorker(siteId: string): Promise<boolean> {
    const { plan, currentWorkers } = await this.getWorkerUsage(siteId);
    if (!plan) return true; // 플랜 없으면 제한 없음 (FREE 취급)
    return currentWorkers < plan.maxWorkers;
  }

  /**
   * 해당 사업장 소유자가 사업장을 추가할 수 있는지 확인
   * 현재 사업장 수 vs Plan.maxSites
   */
  async canAddSite(siteId: string): Promise<boolean> {
    const { plan, currentSites } = await this.getSiteUsage(siteId);
    if (!plan) return true;
    return currentSites < plan.maxSites;
  }

  /**
   * 사용량 정보 반환: workers + sites
   */
  async getUsage(siteId: string) {
    const [workerUsage, siteUsage] = await Promise.all([
      this.getWorkerUsage(siteId),
      this.getSiteUsage(siteId),
    ]);

    // 구독 없으면 Free 플랜 기본값 사용
    let maxWorkers = workerUsage.plan?.maxWorkers ?? 0;
    let maxSites = siteUsage.plan?.maxSites ?? 1;
    if (!workerUsage.plan || !siteUsage.plan) {
      const freePlan = await this.prisma.plan.findUnique({ where: { code: 'FREE' } });
      if (freePlan) {
        if (!workerUsage.plan) maxWorkers = freePlan.maxWorkers;
        if (!siteUsage.plan) maxSites = freePlan.maxSites;
      }
    }

    return {
      workers: {
        current: workerUsage.currentWorkers,
        max: maxWorkers,
        canAdd: maxWorkers > 0 ? workerUsage.currentWorkers < maxWorkers : true,
      },
      sites: {
        current: siteUsage.currentSites,
        max: maxSites,
        canAdd: maxSites > 0 ? siteUsage.currentSites < maxSites : true,
      },
    };
  }

  /**
   * 작업자 추가 전 제한 확인 (초과 시 예외)
   */
  async enforceWorkerLimit(siteId: string): Promise<void> {
    const canAdd = await this.canAddWorker(siteId);
    if (!canAdd) {
      throw new ForbiddenException(
        '작업자 수 상한에 도달했습니다. 플랜 업그레이드가 필요합니다.',
      );
    }
  }

  /**
   * 사업장 추가 전 제한 확인 (초과 시 예외)
   */
  async enforceSiteLimit(siteId: string): Promise<void> {
    const canAdd = await this.canAddSite(siteId);
    if (!canAdd) {
      throw new ForbiddenException(
        '사업장 수 상한에 도달했습니다. 플랜 업그레이드가 필요합니다.',
      );
    }
  }

  // ── private helpers ──

  private async getWorkerUsage(siteId: string) {
    // ★ 플랜은 루트(청구) 사이트 구독 기준 — 하위 사업장은 부모 플랜 상속
    const billingSiteId = await resolveBillingSiteId(this.prisma, siteId);
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        siteId: billingSiteId,
        status: { in: ['ACTIVE', 'TRIAL'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    const currentWorkers = await this.prisma.worker.count({
      where: { siteId, status: 'ACTIVE' },
    });

    return {
      plan: subscription?.plan ?? null,
      currentWorkers,
    };
  }

  private async getSiteUsage(siteId: string) {
    // ★ 루트(청구) 사업장 기준으로 플랜·하위 사업장 수 계산 (다단계 부모 체인 해석)
    const rootSiteId = await resolveBillingSiteId(this.prisma, siteId);

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        siteId: rootSiteId,
        status: { in: ['ACTIVE', 'TRIAL'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    // 루트 사업장 기준으로 하위 사업장 수 계산
    const currentSites = await this.prisma.site.count({
      where: {
        OR: [
          { id: rootSiteId },
          { parentSiteId: rootSiteId },
        ],
        isActive: true,
      },
    });

    return {
      plan: subscription?.plan ?? null,
      currentSites,
    };
  }
}
