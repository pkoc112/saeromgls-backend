import {
  Injectable,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

    return {
      workers: {
        current: workerUsage.currentWorkers,
        max: workerUsage.plan?.maxWorkers ?? 0,
        canAdd: workerUsage.plan
          ? workerUsage.currentWorkers < workerUsage.plan.maxWorkers
          : true,
      },
      sites: {
        current: siteUsage.currentSites,
        max: siteUsage.plan?.maxSites ?? 1,
        canAdd: siteUsage.plan
          ? siteUsage.currentSites < siteUsage.plan.maxSites
          : true,
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
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        siteId,
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
    // 같은 구독(플랜) 아래의 모든 사업장 수 계산
    // parentSiteId가 같은 사업장 + 자기 자신
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { parentSiteId: true },
    });

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        siteId,
        status: { in: ['ACTIVE', 'TRIAL'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    // 루트 사업장 기준으로 하위 사업장 수 계산
    const rootSiteId = site?.parentSiteId ?? siteId;
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
