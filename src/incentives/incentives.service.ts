import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { CreateScoreRunDto } from './dto/create-score-run.dto';
import { CreateObjectionDto } from './dto/create-objection.dto';
import { QueryPolicyDto, QueryScoreRunDto, QueryObjectionDto } from './dto/query-incentives.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class IncentivesService {
  private readonly logger = new Logger(IncentivesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ======================== Policy Versions ========================

  /**
   * 정책 버전 목록 조회
   */
  async getPolicyVersions(siteId: string | undefined, params?: QueryPolicyDto) {
    const where: Prisma.PolicyVersionWhereInput = {};

    if (siteId) {
      where.siteId = siteId;
    }
    if (params?.status) {
      where.status = params.status;
    }
    if (params?.track) {
      where.track = params.track;
    }

    const data = await this.prisma.policyVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return { data };
  }

  /**
   * 정책 버전 생성
   */
  async createPolicyVersion(dto: CreatePolicyDto, siteId: string) {
    // weights JSON 유효성 검증
    let parsedWeights: { performance?: number; reliability?: number; teamwork?: number };
    try {
      parsedWeights = JSON.parse(dto.weights);
    } catch {
      throw new BadRequestException('가중치 JSON 형식이 올바르지 않습니다');
    }

    const { performance = 0, reliability = 0, teamwork = 0 } = parsedWeights;
    const weightSum = performance + reliability + teamwork;
    if (weightSum !== 100) {
      throw new BadRequestException(
        `가중치 합계가 100이어야 합니다 (현재: ${weightSum})`,
      );
    }

    // details JSON 유효성 검증 (선택)
    if (dto.details) {
      try {
        JSON.parse(dto.details);
      } catch {
        throw new BadRequestException('세부 가중치 JSON 형식이 올바르지 않습니다');
      }
    }

    const policyVersion = await this.prisma.policyVersion.create({
      data: {
        siteId,
        name: dto.name,
        track: dto.track,
        weights: dto.weights,
        details: dto.details,
        description: dto.description,
        status: 'DRAFT',
      },
    });

    this.logger.log(`PolicyVersion created: ${policyVersion.id} (${dto.track})`);
    return policyVersion;
  }

  /**
   * 정책 상태 변경: DRAFT -> SHADOW -> ACTIVE -> RETIRED
   */
  async updatePolicyStatus(id: string, status: string) {
    const validStatuses = ['DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `유효하지 않은 상태입니다. 허용: ${validStatuses.join(', ')}`,
      );
    }

    const policy = await this.prisma.policyVersion.findUnique({ where: { id } });
    if (!policy) {
      throw new NotFoundException('정책 버전을 찾을 수 없습니다');
    }

    // 상태 전이 규칙 검증
    const transitions: Record<string, string[]> = {
      DRAFT: ['SHADOW', 'RETIRED'],
      SHADOW: ['ACTIVE', 'DRAFT', 'RETIRED'],
      ACTIVE: ['RETIRED'],
      RETIRED: [],
    };

    const allowed = transitions[policy.status] || [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(
        `${policy.status}에서 ${status}로 변경할 수 없습니다. 허용: ${allowed.join(', ') || '없음'}`,
      );
    }

    // ACTIVE로 변경 시 같은 site+track의 다른 ACTIVE 정책을 RETIRED로 전환
    if (status === 'ACTIVE') {
      await this.prisma.policyVersion.updateMany({
        where: {
          siteId: policy.siteId,
          track: policy.track,
          status: 'ACTIVE',
          id: { not: id },
        },
        data: {
          status: 'RETIRED',
          effectiveTo: new Date(),
        },
      });
    }

    const updated = await this.prisma.policyVersion.update({
      where: { id },
      data: {
        status,
        effectiveFrom: status === 'ACTIVE' ? new Date() : policy.effectiveFrom,
        effectiveTo: status === 'RETIRED' ? new Date() : policy.effectiveTo,
      },
    });

    this.logger.log(`PolicyVersion ${id} status: ${policy.status} -> ${status}`);
    return updated;
  }

  // ======================== Score Runs ========================

  /**
   * 점수 계산 실행
   * 1. 해당 월/사업장의 ENDED 작업 조회
   * 2. 작업자별 그룹핑
   * 3. performance(60), reliability(25), teamwork(15) 산출
   * 4. ScoreEntry 레코드 저장
   * 5. OUTBOUND_RANKED 트랙이면 랭크 산출
   */
  async createScoreRun(siteId: string, dto: CreateScoreRunDto) {
    // 정책 버전 확인
    const policyVersion = await this.prisma.policyVersion.findUnique({
      where: { id: dto.policyVersionId },
    });
    if (!policyVersion) {
      throw new NotFoundException('정책 버전을 찾을 수 없습니다');
    }
    if (!['ACTIVE', 'SHADOW'].includes(policyVersion.status)) {
      throw new BadRequestException('ACTIVE 또는 SHADOW 상태의 정책만 실행할 수 있습니다');
    }

    // 가중치 파싱
    let weights: { performance: number; reliability: number; teamwork: number };
    try {
      weights = JSON.parse(policyVersion.weights);
    } catch {
      throw new BadRequestException('정책 가중치 JSON 파싱 실패');
    }

    // 대상 월의 시작/종료 날짜 계산
    const monthStart = kstStartOfDay(`${dto.month}-01`);
    const lastDay = new Date(
      Number(dto.month.split('-')[0]),
      Number(dto.month.split('-')[1]),
      0,
    ).getDate();
    const monthEnd = kstEndOfDay(`${dto.month}-${String(lastDay).padStart(2, '0')}`);

    // 해당 월/사업장의 ENDED + scoreEligible 작업 조회
    const workItems = await this.prisma.workItem.findMany({
      where: {
        status: 'ENDED',
        scoreEligible: true,
        endedAt: {
          gte: monthStart,
          lte: monthEnd,
        },
        startedByWorker: siteId
          ? { OR: [{ siteId }, { siteId: null }] }
          : undefined,
      },
      include: {
        startedByWorker: { select: { id: true, name: true, siteId: true } },
        assignments: { select: { workerId: true } },
      },
    });

    if (workItems.length === 0) {
      throw new BadRequestException(
        `${dto.month}에 해당하는 종료된 작업이 없습니다`,
      );
    }

    // 작업자별 그룹핑 (시작자 + 참여자 모두 집계)
    const workerMap = new Map<
      string,
      {
        totalCount: number;
        totalVolume: number;
        totalQuantity: number;
        daysWorked: Set<string>;
        teamworkCount: number;
      }
    >();

    for (const item of workItems) {
      // 관련 모든 작업자 ID 수집
      const relatedWorkerIds = new Set<string>();
      relatedWorkerIds.add(item.startedByWorkerId);
      for (const assignment of item.assignments) {
        relatedWorkerIds.add(assignment.workerId);
      }

      const isTeamWork = relatedWorkerIds.size > 1;
      const dayKey = item.endedAt
        ? item.endedAt.toISOString().split('T')[0]
        : item.startedAt.toISOString().split('T')[0];

      for (const wId of relatedWorkerIds) {
        if (!workerMap.has(wId)) {
          workerMap.set(wId, {
            totalCount: 0,
            totalVolume: 0,
            totalQuantity: 0,
            daysWorked: new Set(),
            teamworkCount: 0,
          });
        }
        const stats = workerMap.get(wId)!;
        stats.totalCount += 1;
        stats.totalVolume += Number(item.volume);
        stats.totalQuantity += Number(item.quantity);
        stats.daysWorked.add(dayKey);
        if (isTeamWork) {
          stats.teamworkCount += 1;
        }
      }
    }

    // 전체 평균 산출 (정규화 기준)
    const allStats = Array.from(workerMap.values());
    const avgCount =
      allStats.reduce((s, w) => s + w.totalCount, 0) / allStats.length || 1;
    const avgVolume =
      allStats.reduce((s, w) => s + w.totalVolume, 0) / allStats.length || 1;
    const maxDays = Math.max(...allStats.map((w) => w.daysWorked.size), 1);
    const maxTeamwork = Math.max(...allStats.map((w) => w.teamworkCount), 1);

    // 트랜잭션으로 ScoreRun + ScoreEntry 생성
    const scoreRun = await this.prisma.$transaction(async (tx) => {
      const run = await tx.scoreRun.create({
        data: {
          siteId,
          policyVersionId: dto.policyVersionId,
          month: dto.month,
          status: policyVersion.status === 'SHADOW' ? 'SHADOW' : 'RUNNING',
          totalWorkers: workerMap.size,
        },
      });

      const entries: Array<{
        workerId: string;
        performanceScore: number;
        reliabilityScore: number;
        teamworkScore: number;
        totalScore: number;
      }> = [];

      for (const [workerId, stats] of workerMap.entries()) {
        // Performance: 건수+물량 기반 (가중치 내 60%)
        const countRatio = stats.totalCount / avgCount;
        const volumeRatio = stats.totalVolume / avgVolume;
        const performanceRaw = (countRatio * 0.5 + volumeRatio * 0.5) * 100;
        const performanceScore = Number(
          Math.min(performanceRaw, 100).toFixed(2),
        );

        // Reliability: 출근일수 기반 (가중치 내 25%)
        const reliabilityRaw = (stats.daysWorked.size / maxDays) * 100;
        const reliabilityScore = Number(
          Math.min(reliabilityRaw, 100).toFixed(2),
        );

        // Teamwork: 팀 작업 참여율 (가중치 내 15%)
        const teamworkRaw =
          stats.totalCount > 0
            ? (stats.teamworkCount / stats.totalCount) * 100
            : 0;
        const teamworkScore = Number(Math.min(teamworkRaw, 100).toFixed(2));

        // 가중 합산
        const totalScore = Number(
          (
            (performanceScore * weights.performance) / 100 +
            (reliabilityScore * weights.reliability) / 100 +
            (teamworkScore * weights.teamwork) / 100
          ).toFixed(2),
        );

        entries.push({
          workerId,
          performanceScore,
          reliabilityScore,
          teamworkScore,
          totalScore,
        });

        await tx.scoreEntry.create({
          data: {
            scoreRunId: run.id,
            workerId,
            track: policyVersion.track,
            performanceScore,
            reliabilityScore,
            teamworkScore,
            totalScore,
            details: JSON.stringify({
              totalCount: stats.totalCount,
              totalVolume: Number(stats.totalVolume.toFixed(2)),
              totalQuantity: stats.totalQuantity,
              daysWorked: stats.daysWorked.size,
              teamworkCount: stats.teamworkCount,
            }),
          },
        });
      }

      // OUTBOUND_RANKED: 총점 기준 순위 부여
      if (policyVersion.track === 'OUTBOUND_RANKED') {
        const sorted = [...entries].sort((a, b) => b.totalScore - a.totalScore);
        for (let i = 0; i < sorted.length; i++) {
          await tx.scoreEntry.updateMany({
            where: {
              scoreRunId: run.id,
              workerId: sorted[i].workerId,
            },
            data: { rank: i + 1 },
          });
        }
      }

      return run;
    });

    this.logger.log(
      `ScoreRun created: ${scoreRun.id} (${dto.month}, ${workerMap.size} workers)`,
    );

    return this.getScoreRun(scoreRun.id);
  }

  /**
   * 점수 실행 목록 조회
   */
  async getScoreRuns(siteId: string | undefined, params: QueryScoreRunDto) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ScoreRunWhereInput = {};
    if (siteId) {
      where.siteId = siteId;
    }
    if (params.month) {
      where.month = params.month;
    }

    const [data, total] = await Promise.all([
      this.prisma.scoreRun.findMany({
        where,
        include: {
          policyVersion: { select: { id: true, name: true, track: true } },
          _count: { select: { entries: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.scoreRun.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 점수 실행 상세 (엔트리 포함)
   */
  async getScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id },
      include: {
        policyVersion: { select: { id: true, name: true, track: true, weights: true } },
        entries: {
          include: {
            worker: { select: { id: true, name: true, employeeCode: true } },
          },
          orderBy: { totalScore: 'desc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    }

    return {
      ...run,
      entries: run.entries.map((e) => ({
        ...e,
        performanceScore: Number(e.performanceScore),
        reliabilityScore: Number(e.reliabilityScore),
        teamworkScore: Number(e.teamworkScore),
        totalScore: Number(e.totalScore),
      })),
    };
  }

  /**
   * 점수 엔트리 목록 조회
   */
  async getScoreEntries(runId: string) {
    const entries = await this.prisma.scoreEntry.findMany({
      where: { scoreRunId: runId },
      include: {
        worker: { select: { id: true, name: true, employeeCode: true } },
      },
      orderBy: { totalScore: 'desc' },
    });

    return entries.map((e) => ({
      ...e,
      performanceScore: Number(e.performanceScore),
      reliabilityScore: Number(e.reliabilityScore),
      teamworkScore: Number(e.teamworkScore),
      totalScore: Number(e.totalScore),
    }));
  }

  /**
   * 점수 실행 동결 (RUNNING/SHADOW -> FROZEN)
   */
  async freezeScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    }
    if (!['RUNNING', 'SHADOW'].includes(run.status)) {
      throw new BadRequestException('RUNNING 또는 SHADOW 상태만 동결할 수 있습니다');
    }

    const updated = await this.prisma.scoreRun.update({
      where: { id },
      data: {
        status: 'FROZEN',
        frozenAt: new Date(),
      },
    });

    this.logger.log(`ScoreRun frozen: ${id}`);
    return this.getScoreRun(updated.id);
  }

  /**
   * 점수 실행 확정 (FROZEN -> FINALIZED)
   */
  async finalizeScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({ where: { id } });
    if (!run) {
      throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    }
    if (run.status !== 'FROZEN') {
      throw new BadRequestException('동결 상태의 실행만 확정할 수 있습니다');
    }

    const updated = await this.prisma.scoreRun.update({
      where: { id },
      data: {
        status: 'FINALIZED',
        finalizedAt: new Date(),
      },
    });

    this.logger.log(`ScoreRun finalized: ${id}`);
    return this.getScoreRun(updated.id);
  }

  // ======================== Objections ========================

  /**
   * 이의신청 목록 조회
   */
  async getObjections(siteId: string | undefined, params: QueryObjectionDto) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ObjectionCaseWhereInput = {};
    if (siteId) {
      where.siteId = siteId;
    }
    if (params.status) {
      where.status = params.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.objectionCase.findMany({
        where,
        include: {
          worker: { select: { id: true, name: true, employeeCode: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.objectionCase.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 이의신청 생성
   */
  async createObjection(dto: CreateObjectionDto, siteId: string, workerId: string) {
    // scoreEntryId 유효성 검증 (제공된 경우)
    if (dto.scoreEntryId) {
      const entry = await this.prisma.scoreEntry.findUnique({
        where: { id: dto.scoreEntryId },
      });
      if (!entry) {
        throw new NotFoundException('점수 항목을 찾을 수 없습니다');
      }
    }

    const objection = await this.prisma.objectionCase.create({
      data: {
        scoreEntryId: dto.scoreEntryId,
        workerId,
        siteId,
        month: dto.month,
        reason: dto.reason,
        status: 'OPEN',
      },
      include: {
        worker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    this.logger.log(`Objection created: ${objection.id} by worker ${workerId}`);
    return objection;
  }

  /**
   * 이의신청 처리 (ACCEPTED/REJECTED)
   */
  async resolveObjection(id: string, resolution: string, resolvedByWorkerId: string) {
    const objection = await this.prisma.objectionCase.findUnique({ where: { id } });
    if (!objection) {
      throw new NotFoundException('이의신청을 찾을 수 없습니다');
    }
    if (!['OPEN', 'REVIEWING'].includes(objection.status)) {
      throw new BadRequestException('처리 가능한 상태가 아닙니다 (OPEN 또는 REVIEWING만 가능)');
    }

    // resolution에 따라 상태 결정
    const isAccepted = resolution.toLowerCase().startsWith('accept');
    const newStatus = isAccepted ? 'ACCEPTED' : 'REJECTED';

    const updated = await this.prisma.objectionCase.update({
      where: { id },
      data: {
        status: newStatus,
        resolution,
        resolvedBy: resolvedByWorkerId,
        resolvedAt: new Date(),
      },
      include: {
        worker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    this.logger.log(`Objection ${id} resolved: ${newStatus}`);
    return updated;
  }
}
