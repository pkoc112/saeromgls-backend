import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSiteFromTemplateDto,
  CreateSupportCaseDto,
  GenerateUsageSnapshotDto,
  ResolveSupportCaseDto,
  UpdateOnboardingRunDto,
  UpsertTenantSettingsDto,
} from './dto/customer-ops.dto';

type SiteHealth = 'HEALTHY' | 'NEEDS_ATTENTION' | 'AT_RISK';

@Injectable()
export class CustomerOpsService {
  private readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000;
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LONG_RUNNING_THRESHOLD_HOURS = 8;

  constructor(private readonly prisma: PrismaService) {}

  async getCustomerOverview(siteId?: string) {
    const sites = await this.buildSiteOverview(siteId);

    const totalSites = sites.length;
    const activeSites = sites.filter((site) => site.isActive).length;
    const totalWorkers = sites.reduce((sum, site) => sum + site.workerCount, 0);
    const totalWorkItems = sites.reduce((sum, site) => sum + site.workItemCount, 0);
    const openCaseCount = sites.reduce((sum, site) => sum + site.openCaseCount, 0);
    const subscriptionRiskCount = sites.filter((site) =>
      ['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(
        site.subscriptionStatus,
      ),
    ).length;
    const onboardingIncompleteCount = sites.filter(
      (site) => site.onboarding.status !== 'COMPLETED',
    ).length;
    const attentionSiteCount = sites.filter(
      (site) => site.health !== 'HEALTHY',
    ).length;
    const lowActivityCount = sites.filter(
      (site) => site.daysSinceLastActivity !== null && site.daysSinceLastActivity >= 7,
    ).length;

    return {
      stats: {
        totalSites,
        activeSites,
        totalWorkers,
        totalWorkItems,
        openCaseCount,
        subscriptionRiskCount,
        onboardingIncompleteCount,
        attentionSiteCount,
        lowActivityCount,
      },
      sites,
    };
  }

  async getOperationsConsole(siteId?: string) {
    const overview = await this.getCustomerOverview(siteId);
    const lockedWorkers = await this.getLockedWorkers(siteId);
    const failedLogins = await this.getRecentFailedLogins(siteId);

    const actions = overview.sites
      .flatMap((site) => {
        const siteActions: Array<{
          id: string;
          severity: 'critical' | 'warning' | 'info';
          type: string;
          siteId: string;
          siteName: string;
          title: string;
          description: string;
          href: string;
        }> = [];

        if (site.longRunningActiveCount > 0) {
          siteActions.push({
            id: `${site.id}-long-running`,
            severity: 'critical',
            type: 'long_running',
            siteId: site.id,
            siteName: site.name,
            title: '장시간 미종료 작업 확인',
            description: `${site.longRunningActiveCount}건의 장시간 진행 작업이 있습니다.`,
            href: '/work-items',
          });
        }

        if (['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(site.subscriptionStatus)) {
          siteActions.push({
            id: `${site.id}-subscription`,
            severity: 'critical',
            type: 'subscription',
            siteId: site.id,
            siteName: site.name,
            title: '구독 상태 점검 필요',
            description: `현재 구독 상태는 ${site.subscriptionStatus} 입니다.`,
            href: '/billing',
          });
        }

        if (site.onboarding.status !== 'COMPLETED') {
          siteActions.push({
            id: `${site.id}-onboarding`,
            severity: 'warning',
            type: 'onboarding',
            siteId: site.id,
            siteName: site.name,
            title: '온보딩 미완료',
            description: `${site.onboarding.progressPercent}% 진행 (${site.onboarding.step}/${site.onboarding.totalSteps})`,
            href: '/onboarding',
          });
        }

        if (site.openCaseCount > 0) {
          siteActions.push({
            id: `${site.id}-support`,
            severity: site.p1OpenCaseCount > 0 ? 'critical' : 'warning',
            type: 'support',
            siteId: site.id,
            siteName: site.name,
            title: '열린 지원 케이스 확인',
            description: `미해결 지원 케이스 ${site.openCaseCount}건이 있습니다.`,
            href: '/support-cases',
          });
        }

        if (site.daysSinceLastActivity !== null && site.daysSinceLastActivity >= 7) {
          siteActions.push({
            id: `${site.id}-inactive`,
            severity: 'warning',
            type: 'adoption',
            siteId: site.id,
            siteName: site.name,
            title: '활동 저하 고객',
            description: `마지막 활동 후 ${site.daysSinceLastActivity}일이 지났습니다.`,
            href: '/customer-overview',
          });
        }

        return siteActions;
      })
      .sort((a, b) => this.getSeverityRank(a.severity) - this.getSeverityRank(b.severity))
      .slice(0, 12);

    const last30dWorkItems = overview.sites.reduce(
      (sum, site) => sum + site.metrics.last30dWorkItems,
      0,
    );
    const previous30dWorkItems = overview.sites.reduce(
      (sum, site) => sum + site.metrics.previous30dWorkItems,
      0,
    );
    const trendPercent = this.calculateTrend(last30dWorkItems, previous30dWorkItems);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalSites: overview.stats.totalSites,
        attentionSites: overview.stats.attentionSiteCount,
        openSupportCases: overview.stats.openCaseCount,
        subscriptionRisks: overview.stats.subscriptionRiskCount,
        pendingOnboarding: overview.stats.onboardingIncompleteCount,
        lowActivitySites: overview.stats.lowActivityCount,
        lockedAccounts: lockedWorkers.length,
        failedLogins24h: failedLogins.length,
      },
      valueMetrics: {
        last30dWorkItems,
        previous30dWorkItems,
        trendPercent,
        averageDailyWorkItems:
          Number((last30dWorkItems / 30).toFixed(1)) || 0,
        activeSiteRatio:
          overview.stats.totalSites === 0
            ? 0
            : Number(
                (
                  (overview.stats.activeSites / overview.stats.totalSites) *
                  100
                ).toFixed(1),
              ),
      },
      security: {
        lockedWorkers,
        recentFailedLogins: failedLogins.slice(0, 10),
      },
      actions,
    };
  }

  async getSiteTemplates() {
    return this.prisma.siteTemplate.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSiteFromTemplate(dto: CreateSiteFromTemplateDto) {
    const template = await this.prisma.siteTemplate.findUnique({
      where: { id: dto.templateId },
    });
    if (!template) {
      throw new NotFoundException('사이트 템플릿을 찾을 수 없습니다');
    }

    const existing = await this.prisma.site.findUnique({
      where: { code: dto.siteCode },
    });
    if (existing) {
      throw new BadRequestException('이미 존재하는 사이트 코드입니다');
    }

    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.create({
        data: {
          name: dto.siteName,
          code: dto.siteCode,
          isActive: true,
        },
      });

      let classifications: Array<{
        code: string;
        displayName: string;
        sortOrder?: number;
      }> = [];
      try {
        classifications = JSON.parse(template.classificationsJson);
      } catch {
        classifications = [];
      }

      if (classifications.length > 0) {
        await tx.classification.createMany({
          data: classifications.map((item, index) => ({
            code: `${dto.siteCode}_${item.code}`,
            displayName: item.displayName,
            sortOrder: item.sortOrder ?? index,
            siteId: site.id,
          })),
        });
      }

      let breakConfigs: Array<{
        label: string;
        startHour: number;
        startMin: number;
        endHour: number;
        endMin: number;
      }> = [];
      try {
        breakConfigs = JSON.parse(template.breakConfigsJson);
      } catch {
        breakConfigs = [];
      }

      if (breakConfigs.length > 0) {
        await tx.breakConfig.createMany({
          data: breakConfigs.map((item, index) => ({
            label: item.label,
            startHour: item.startHour,
            startMin: item.startMin,
            endHour: item.endHour,
            endMin: item.endMin,
            siteId: site.id,
            sortOrder: index,
          })),
        });
      }

      await tx.onboardingRun.create({
        data: {
          siteId: site.id,
          step: 1,
          totalSteps: 9,
          status: 'IN_PROGRESS',
        },
      });

      await tx.tenantSettings.create({
        data: {
          siteId: site.id,
          settings: JSON.stringify({
            timezone: 'Asia/Seoul',
            language: 'ko',
            workStartHour: 8,
            workEndHour: 18,
            kioskMode: true,
            autoScreensaverSeconds: 60,
            noticeMessage: '',
          }),
        },
      });

      return {
        site,
        classificationsCreated: classifications.length,
        breakConfigsCreated: breakConfigs.length,
        message: `사이트 "${dto.siteName}"이(가) 성공적으로 생성되었습니다`,
      };
    });
  }

  async getSupportCases(siteId?: string, status?: string) {
    const where: Prisma.SupportCaseWhereInput = {};
    if (siteId) where.siteId = siteId;
    if (status) where.status = status;

    return this.prisma.supportCase.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSupportCase(dto: CreateSupportCaseDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    return this.prisma.supportCase.create({
      data: {
        siteId: dto.siteId,
        reporterId: dto.reporterId || null,
        severity: dto.severity || 'P3',
        title: dto.title,
        description: dto.description || null,
        status: 'OPEN',
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async resolveSupportCase(id: string, dto: ResolveSupportCaseDto) {
    const supportCase = await this.prisma.supportCase.findUnique({
      where: { id },
    });
    if (!supportCase) {
      throw new NotFoundException('지원 케이스를 찾을 수 없습니다');
    }
    if (supportCase.status === 'RESOLVED' || supportCase.status === 'CLOSED') {
      throw new BadRequestException('이미 해결된 케이스입니다');
    }

    return this.prisma.supportCase.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution: dto.resolution,
        resolvedAt: new Date(),
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async generateUsageSnapshot(dto: GenerateUsageSnapshotDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const [year, month] = dto.month.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1);

    const workerCount = await this.prisma.worker.count({
      where: {
        OR: [{ siteId: dto.siteId }, { siteId: null }],
        status: 'ACTIVE',
        role: { notIn: ['MASTER'] },
      },
    });

    const workItems = await this.prisma.workItem.findMany({
      where: {
        startedByWorker: {
          OR: [{ siteId: dto.siteId }, { siteId: null }],
        },
        startedAt: { gte: monthStart, lt: monthEnd },
      },
      select: { volume: true, quantity: true },
    });

    const workItemCount = workItems.length;
    const totalVolume = workItems.reduce(
      (sum, item) => sum + Number(item.volume),
      0,
    );
    const totalQuantity = workItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    return this.prisma.usageSnapshot.upsert({
      where: {
        siteId_month: {
          siteId: dto.siteId,
          month: dto.month,
        },
      },
      update: {
        workerCount,
        workItemCount,
        totalVolume,
        totalQuantity,
      },
      create: {
        siteId: dto.siteId,
        month: dto.month,
        workerCount,
        workItemCount,
        totalVolume,
        totalQuantity,
      },
    });
  }

  async getUsageSnapshots(siteId?: string) {
    const where: Prisma.UsageSnapshotWhereInput = {};
    if (siteId) where.siteId = siteId;

    return this.prisma.usageSnapshot.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ month: 'desc' }, { siteId: 'asc' }],
    });
  }

  async getOnboardingRuns(siteId?: string) {
    const where: Prisma.OnboardingRunWhereInput = {};
    if (siteId) where.siteId = siteId;

    const runs = await this.prisma.onboardingRun.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ startedAt: 'desc' }],
    });

    return runs.map((run) => ({
      ...run,
      progressPercent:
        run.status === 'COMPLETED'
          ? 100
          : Math.round((run.step / Math.max(run.totalSteps, 1)) * 100),
    }));
  }

  async startOnboardingRun(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const existing = await this.prisma.onboardingRun.findFirst({
      where: {
        siteId,
        status: 'IN_PROGRESS',
      },
      orderBy: { startedAt: 'desc' },
    });

    if (existing) {
      return {
        ...existing,
        progressPercent: Math.round(
          (existing.step / Math.max(existing.totalSteps, 1)) * 100,
        ),
      };
    }

    const run = await this.prisma.onboardingRun.create({
      data: {
        siteId,
        step: 1,
        totalSteps: 9,
        status: 'IN_PROGRESS',
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      ...run,
      progressPercent: Math.round((run.step / run.totalSteps) * 100),
    };
  }

  async updateOnboardingRun(
    id: string,
    dto: UpdateOnboardingRunDto,
    user: JwtPayload,
  ) {
    const run = await this.prisma.onboardingRun.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
    if (!run) {
      throw new NotFoundException('온보딩 실행 기록을 찾을 수 없습니다');
    }

    if (user.role !== 'MASTER' && run.siteId !== user.siteId) {
      throw new ForbiddenException('자신의 사이트 온보딩만 수정할 수 있습니다');
    }

    let step = dto.step ?? run.step;
    const totalSteps = dto.totalSteps ?? run.totalSteps;

    if (dto.markStepComplete) {
      step = Math.min(step + 1, totalSteps);
    }

    const status =
      dto.status ||
      (step >= totalSteps ? 'COMPLETED' : run.status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS');

    const updated = await this.prisma.onboardingRun.update({
      where: { id },
      data: {
        step,
        totalSteps,
        status,
        notes: dto.notes ?? run.notes,
        completedAt: status === 'COMPLETED' ? new Date() : null,
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      ...updated,
      progressPercent:
        status === 'COMPLETED'
          ? 100
          : Math.round((updated.step / Math.max(updated.totalSteps, 1)) * 100),
    };
  }

  async getTenantSettings(siteId?: string) {
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { siteId },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    if (!settings) {
      return {
        siteId,
        settings: {
          timezone: 'Asia/Seoul',
          language: 'ko',
          workStartHour: 8,
          workEndHour: 18,
          kioskMode: true,
          autoScreensaverSeconds: 60,
          noticeMessage: '',
        },
      };
    }

    return {
      id: settings.id,
      siteId: settings.siteId,
      site: settings.site,
      settings: this.safeParseJson(settings.settings),
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  async updateTenantSettings(
    siteId: string | undefined,
    dto: UpsertTenantSettingsDto,
  ) {
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const existing = await this.prisma.tenantSettings.findUnique({
      where: { siteId },
    });
    const current = existing ? this.safeParseJson(existing.settings) : {};
    const merged = {
      timezone: 'Asia/Seoul',
      language: 'ko',
      workStartHour: 8,
      workEndHour: 18,
      kioskMode: true,
      autoScreensaverSeconds: 60,
      noticeMessage: '',
      ...current,
      ...dto,
      ...(dto.extra || {}),
    };

    const result = await this.prisma.tenantSettings.upsert({
      where: { siteId },
      update: {
        settings: JSON.stringify(merged),
      },
      create: {
        siteId,
        settings: JSON.stringify(merged),
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      id: result.id,
      siteId: result.siteId,
      site: result.site,
      settings: merged,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  private async buildSiteOverview(siteId?: string) {
    const sites = await this.prisma.site.findMany({
      where: siteId ? { id: siteId } : { parentSiteId: null },
      include: {
        subscriptions: {
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const prev30Start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const longRunningThreshold = new Date(
      now.getTime() - this.LONG_RUNNING_THRESHOLD_HOURS * 60 * 60 * 1000,
    );

    return Promise.all(
      sites.map(async (site) => {
        const siteWorkerFilter: Prisma.WorkerWhereInput = {
          OR: [{ siteId: site.id }, { siteId: null }],
          status: 'ACTIVE',
          role: { notIn: ['MASTER'] },
        };
        const siteWorkItemFilter: Prisma.WorkItemWhereInput = {
          startedByWorker: { OR: [{ siteId: site.id }, { siteId: null }] },
        };

        const [
          workerCount,
          last30dWorkItems,
          previous30dWorkItems,
          recent7dTotalCount,
          recent7dEndedCount,
          activeCount,
          longRunningActiveCount,
          lastWorkItem,
          openCaseCount,
          p1OpenCaseCount,
          onboardingRun,
          latestUsageSnapshot,
        ] = await Promise.all([
          this.prisma.worker.count({ where: siteWorkerFilter }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: last30Start },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: prev30Start, lt: last30Start },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: sevenDaysAgo },
              status: { not: 'VOID' },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: sevenDaysAgo },
              status: 'ENDED',
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              status: 'ACTIVE',
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              status: 'ACTIVE',
              startedAt: { lte: longRunningThreshold },
            },
          }),
          this.prisma.workItem.findFirst({
            where: siteWorkItemFilter,
            orderBy: { startedAt: 'desc' },
            select: { startedAt: true },
          }),
          this.prisma.supportCase.count({
            where: {
              siteId: site.id,
              status: { in: ['OPEN', 'IN_PROGRESS'] },
            },
          }),
          this.prisma.supportCase.count({
            where: {
              siteId: site.id,
              status: { in: ['OPEN', 'IN_PROGRESS'] },
              severity: 'P1',
            },
          }),
          this.prisma.onboardingRun.findFirst({
            where: { siteId: site.id },
            orderBy: { startedAt: 'desc' },
          }),
          this.prisma.usageSnapshot.findFirst({
            where: { siteId: site.id },
            orderBy: { month: 'desc' },
          }),
        ]);

        const subscription = site.subscriptions[0] || null;
        const subscriptionStatus = subscription?.status || 'NONE';
        const onboardingProgressPercent = onboardingRun
          ? onboardingRun.status === 'COMPLETED'
            ? 100
            : Math.round(
                (onboardingRun.step / Math.max(onboardingRun.totalSteps, 1)) * 100,
              )
          : 0;

        const daysSinceLastActivity = lastWorkItem?.startedAt
          ? Math.floor(
              (now.getTime() - lastWorkItem.startedAt.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : null;

        const healthReasons: string[] = [];
        let health: SiteHealth = 'HEALTHY';

        if (
          ['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(subscriptionStatus)
        ) {
          health = 'AT_RISK';
          healthReasons.push(`구독 상태 ${subscriptionStatus}`);
        }
        if (p1OpenCaseCount > 0) {
          health = 'AT_RISK';
          healthReasons.push(`P1 지원 케이스 ${p1OpenCaseCount}건`);
        }
        if (longRunningActiveCount > 0) {
          health = 'AT_RISK';
          healthReasons.push(`장시간 진행중 ${longRunningActiveCount}건`);
        }
        if (
          health !== 'AT_RISK' &&
          (openCaseCount > 0 ||
            (daysSinceLastActivity !== null && daysSinceLastActivity >= 7) ||
            (onboardingRun && onboardingRun.status !== 'COMPLETED'))
        ) {
          health = 'NEEDS_ATTENTION';
        }
        if (openCaseCount > 0 && !healthReasons.includes(`지원 케이스 ${openCaseCount}건`)) {
          healthReasons.push(`지원 케이스 ${openCaseCount}건`);
        }
        if (daysSinceLastActivity !== null && daysSinceLastActivity >= 7) {
          healthReasons.push(`최근 활동 ${daysSinceLastActivity}일 전`);
        }
        if (onboardingRun && onboardingRun.status !== 'COMPLETED') {
          healthReasons.push(`온보딩 ${onboardingProgressPercent}%`);
        }

        const workerUtilizationPercent =
          subscription?.plan?.maxWorkers && latestUsageSnapshot
            ? Number(
                (
                  (latestUsageSnapshot.workerCount / subscription.plan.maxWorkers) *
                  100
                ).toFixed(1),
              )
            : null;

        return {
          id: site.id,
          name: site.name,
          code: site.code,
          isActive: site.isActive,
          createdAt: site.createdAt,
          workerCount,
          workItemCount: last30dWorkItems,
          openCaseCount,
          p1OpenCaseCount,
          activeCount,
          longRunningActiveCount,
          lastActivity: lastWorkItem?.startedAt || null,
          daysSinceLastActivity,
          subscriptionStatus,
          subscriptionPlanName: subscription?.plan?.name || 'Free',
          health,
          healthReasons,
          onboarding: {
            status: onboardingRun?.status || 'NOT_STARTED',
            step: onboardingRun?.step || 0,
            totalSteps: onboardingRun?.totalSteps || 9,
            progressPercent: onboardingProgressPercent,
            updatedAt: onboardingRun?.completedAt || onboardingRun?.startedAt || null,
          },
          usage: latestUsageSnapshot
            ? {
                month: latestUsageSnapshot.month,
                workerCount: latestUsageSnapshot.workerCount,
                workItemCount: latestUsageSnapshot.workItemCount,
                totalVolume: Number(latestUsageSnapshot.totalVolume),
                totalQuantity: latestUsageSnapshot.totalQuantity,
                workerUtilizationPercent,
              }
            : null,
          metrics: {
            last30dWorkItems,
            previous30dWorkItems,
            trendPercent: this.calculateTrend(
              last30dWorkItems,
              previous30dWorkItems,
            ),
            averageDailyWorkItems: Number((last30dWorkItems / 30).toFixed(1)),
            completionRate7d:
              recent7dTotalCount === 0
                ? 0
                : Number(
                    ((recent7dEndedCount / recent7dTotalCount) * 100).toFixed(1),
                  ),
          },
        };
      }),
    );
  }

  private async getRecentFailedLogins(siteId?: string) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.prisma.loginHistory.findMany({
      where: {
        success: false,
        createdAt: { gte: dayAgo },
        ...(siteId && { worker: { OR: [{ siteId }, { siteId: null }] } }),
      },
      include: {
        worker: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            site: { select: { id: true, name: true, code: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
  }

  private async getLockedWorkers(siteId?: string) {
    const lockoutCutoff = new Date(Date.now() - this.LOCKOUT_DURATION_MS);

    const workers = await this.prisma.worker.findMany({
      where: {
        status: 'ACTIVE',
        role: { notIn: ['MASTER'] },
        ...(siteId && { OR: [{ siteId }, { siteId: null }] }),
      },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        site: { select: { id: true, name: true, code: true } },
      },
    });

    if (workers.length === 0) {
      return [];
    }

    const recentHistory = await this.prisma.loginHistory.findMany({
      where: {
        workerId: { in: workers.map((worker) => worker.id) },
        createdAt: { gte: lockoutCutoff },
      },
      orderBy: { createdAt: 'desc' },
    });

    const historyByWorker = new Map<string, typeof recentHistory>();
    for (const item of recentHistory) {
      const bucket = historyByWorker.get(item.workerId) || [];
      bucket.push(item);
      historyByWorker.set(item.workerId, bucket);
    }

    return workers
      .filter((worker) => {
        const bucket = (historyByWorker.get(worker.id) || []).slice(
          0,
          this.MAX_FAILED_ATTEMPTS,
        );
        return (
          bucket.length >= this.MAX_FAILED_ATTEMPTS &&
          bucket.every((entry) => !entry.success)
        );
      })
      .map((worker) => ({
        workerId: worker.id,
        name: worker.name,
        employeeCode: worker.employeeCode,
        site: worker.site,
      }));
  }

  private calculateTrend(current: number, previous: number) {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return Number((((current - previous) / previous) * 100).toFixed(1));
  }

  private safeParseJson(input: string | null | undefined) {
    if (!input) return {};
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private getSeverityRank(severity: 'critical' | 'warning' | 'info') {
    if (severity === 'critical') return 0;
    if (severity === 'warning') return 1;
    return 2;
  }
}
