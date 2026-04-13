import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSiteFromTemplateDto,
  CreateSupportCaseDto,
  ResolveSupportCaseDto,
  GenerateUsageSnapshotDto,
} from './dto/customer-ops.dto';

@Injectable()
export class CustomerOpsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 고객 현황 개요: 모든 사업장 + 작업자 수 + 작업 수 + 구독 상태 + 최근 활동
   */
  async getCustomerOverview() {
    const sites = await this.prisma.site.findMany({
      where: { parentSiteId: null },
      include: {
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'TRIAL'] } },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = await Promise.all(
      sites.map(async (site) => {
        const workerCount = await this.prisma.worker.count({
          where: {
            OR: [{ siteId: site.id }, { siteId: null }],
            status: 'ACTIVE',
            role: { notIn: ['MASTER'] },
          },
        });

        const workItemCount = await this.prisma.workItem.count({
          where: {
            startedByWorker: {
              OR: [{ siteId: site.id }, { siteId: null }],
            },
            startedAt: { gte: monthStart },
          },
        });

        const lastWorkItem = await this.prisma.workItem.findFirst({
          where: {
            startedByWorker: {
              OR: [{ siteId: site.id }, { siteId: null }],
            },
          },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        });

        const subscription = site.subscriptions[0] || null;

        return {
          id: site.id,
          name: site.name,
          code: site.code,
          isActive: site.isActive,
          createdAt: site.createdAt,
          workerCount,
          workItemCount,
          subscriptionStatus: subscription?.status || 'NONE',
          lastActivity: lastWorkItem?.startedAt || null,
        };
      }),
    );

    // 집계 통계
    const totalSites = result.length;
    const activeSites = result.filter((s) => s.isActive).length;
    const totalWorkers = result.reduce((sum, s) => sum + s.workerCount, 0);
    const totalWorkItems = result.reduce((sum, s) => sum + s.workItemCount, 0);

    // 열린 지원 케이스 수
    const openCaseCount = await this.prisma.supportCase.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });

    return {
      stats: {
        totalSites,
        activeSites,
        totalWorkers,
        totalWorkItems,
        openCaseCount,
      },
      sites: result,
    };
  }

  /**
   * 사업장 템플릿 목록 조회
   */
  async getSiteTemplates() {
    return this.prisma.siteTemplate.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 템플릿 기반 사업장 생성
   */
  async createSiteFromTemplate(dto: CreateSiteFromTemplateDto) {
    const template = await this.prisma.siteTemplate.findUnique({
      where: { id: dto.templateId },
    });
    if (!template) {
      throw new NotFoundException('템플릿을 찾을 수 없습니다');
    }

    // 사업장 코드 중복 확인
    const existing = await this.prisma.site.findUnique({
      where: { code: dto.siteCode },
    });
    if (existing) {
      throw new BadRequestException('이미 존재하는 사업장 코드입니다');
    }

    // 트랜잭션으로 사업장 + 분류 + 휴게시간 한번에 생성
    return this.prisma.$transaction(async (tx) => {
      // 1. 사업장 생성
      const site = await tx.site.create({
        data: {
          name: dto.siteName,
          code: dto.siteCode,
          isActive: true,
        },
      });

      // 2. 분류 코드 생성 (템플릿에서)
      let classifications: Array<{
        code: string;
        displayName: string;
        sortOrder?: number;
      }> = [];
      try {
        classifications = JSON.parse(template.classificationsJson);
      } catch {
        // JSON 파싱 실패 시 빈 배열
      }
      if (classifications.length > 0) {
        await tx.classification.createMany({
          data: classifications.map((c, idx) => ({
            code: `${dto.siteCode}_${c.code}`,
            displayName: c.displayName,
            sortOrder: c.sortOrder ?? idx,
            siteId: site.id,
          })),
        });
      }

      // 3. 휴게시간 설정 (템플릿에서)
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
        // JSON 파싱 실패 시 빈 배열
      }
      if (breakConfigs.length > 0) {
        await tx.breakConfig.createMany({
          data: breakConfigs.map((b, idx) => ({
            label: b.label,
            startHour: b.startHour,
            startMin: b.startMin,
            endHour: b.endHour,
            endMin: b.endMin,
            siteId: site.id,
            sortOrder: idx,
          })),
        });
      }

      // 4. 온보딩 시작 기록
      await tx.onboardingRun.create({
        data: {
          siteId: site.id,
          step: 1,
          totalSteps: 9,
          status: 'IN_PROGRESS',
        },
      });

      // 5. 테넌트 기본 설정
      await tx.tenantSettings.create({
        data: {
          siteId: site.id,
          settings: JSON.stringify({
            timezone: 'Asia/Seoul',
            language: 'ko',
            workStartHour: 8,
            workEndHour: 18,
          }),
        },
      });

      return {
        site,
        classificationsCreated: classifications.length,
        breakConfigsCreated: breakConfigs.length,
        message: `사업장 "${dto.siteName}"이(가) 성공적으로 생성되었습니다`,
      };
    });
  }

  /**
   * 지원 케이스 목록 조회
   */
  async getSupportCases(siteId?: string, status?: string) {
    const where: Record<string, unknown> = {};
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

  /**
   * 지원 케이스 생성
   */
  async createSupportCase(dto: CreateSupportCaseDto) {
    // 사업장 존재 확인
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
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

  /**
   * 지원 케이스 해결 처리
   */
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

  /**
   * 사용량 스냅샷 생성 (월간)
   */
  async generateUsageSnapshot(dto: GenerateUsageSnapshotDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
    }

    // 해당 월의 시작/종료 날짜 계산
    const [year, month] = dto.month.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1);

    // 작업자 수 (해당 사업장 + siteId NULL)
    const workerCount = await this.prisma.worker.count({
      where: {
        OR: [{ siteId: dto.siteId }, { siteId: null }],
        status: 'ACTIVE',
        role: { notIn: ['MASTER'] },
      },
    });

    // 작업 기록 집계
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
      (sum, w) => sum + Number(w.volume),
      0,
    );
    const totalQuantity = workItems.reduce((sum, w) => sum + w.quantity, 0);

    // upsert: 이미 해당 월 스냅샷이 있으면 업데이트
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

  /**
   * 사용량 스냅샷 목록 조회
   */
  async getUsageSnapshots(siteId?: string) {
    const where: Record<string, unknown> = {};
    if (siteId) where.siteId = siteId;

    return this.prisma.usageSnapshot.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ month: 'desc' }, { siteId: 'asc' }],
    });
  }
}
