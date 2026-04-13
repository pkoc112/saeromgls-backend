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

// ======================== Track-Specific Scoring Types ========================

interface ExplanationPerformance {
  total: number;
  [key: string]: unknown;
}

interface ExplanationReliability {
  total: number;
  voidRate?: { value: number; penalty: number };
  editRate?: { value: number; penalty: number };
  completionRate?: { value: number; score: number };
}

interface ExplanationTeamwork {
  total: number;
  coworkerSessions?: number;
  multiAssignments?: number;
  sessionTeamwork?: number;
  supportContribution?: number;
}

interface ScoreExplanation {
  track: string;
  performance: ExplanationPerformance;
  reliability: ExplanationReliability;
  teamwork: ExplanationTeamwork;
}

interface WorkerScoreData {
  workerId: string;
  performanceScore: number;
  reliabilityScore: number;
  teamworkScore: number;
  totalScore: number;
  explanationJson: ScoreExplanation;
}

interface TrackWorkerStats {
  totalCount: number;
  totalVolume: number;
  totalQuantity: number;
  daysWorked: Set<string>;
  teamworkCount: number;
  // Extended stats for track-specific scoring
  voidCount: number;
  editCount: number;
  completedCount: number;
  totalHoursWorked: number;
  coworkerCount: number;
  multiAssignmentCount: number;
  // Inspection-specific
  inspectionsConducted: number;
  inspectionDefects: number;
  inspectionQuantity: number;
  // Inbound-specific
  inboundSessionCount: number;
  inboundApprovedQuantity: number;
  // Dock-specific
  dockSessionCount: number;
  wrapSessionCount: number;
}

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
   * 2. 트랙별 추가 데이터 조회 (inspection, inbound, dock)
   * 3. 트랙별 scoring 로직 적용
   * 4. explanationJson 생성
   * 5. OUTBOUND_RANKED 트랙 → 랭크 산출
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

    // MANAGER_OPS 는 별도 보너스 구조이므로 스킵
    if (policyVersion.track === 'MANAGER_OPS') {
      throw new BadRequestException('MANAGER_OPS 트랙은 별도 보너스 구조로 관리됩니다. 점수 계산이 지원되지 않습니다.');
    }

    // 가중치 파싱
    let weights: { performance: number; reliability: number; teamwork: number };
    try {
      weights = JSON.parse(policyVersion.weights);
    } catch {
      throw new BadRequestException('정책 가중치 JSON 파싱 실패');
    }

    // 세부 가중치 파싱 (선택)
    let details: Record<string, unknown> = {};
    if (policyVersion.details) {
      try {
        details = JSON.parse(policyVersion.details);
      } catch {
        this.logger.warn('정책 세부 가중치 JSON 파싱 실패, 기본값 사용');
      }
    }

    // 대상 월의 시작/종료 날짜 계산
    const monthStart = kstStartOfDay(`${dto.month}-01`);
    const lastDay = new Date(
      Number(dto.month.split('-')[0]),
      Number(dto.month.split('-')[1]),
      0,
    ).getDate();
    const monthEnd = kstEndOfDay(`${dto.month}-${String(lastDay).padStart(2, '0')}`);

    const track = policyVersion.track;

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
        auditLogs: { select: { action: true } },
      },
    });

    if (workItems.length === 0) {
      throw new BadRequestException(
        `${dto.month}에 해당하는 종료된 작업이 없습니다`,
      );
    }

    // 트랙별 추가 데이터 조회
    const siteFilter = siteId ? { OR: [{ siteId }, { siteId: null as string | null }] } : {};
    const siteFilterDirect = siteId ? { siteId } : {};

    // Inspection records (INSPECTION_GOAL 트랙)
    let inspectionRecords: Array<{
      inspectedByWorkerId: string;
      result: string;
      quantityChecked: number;
      quantityDefect: number;
    }> = [];
    if (track === 'INSPECTION_GOAL') {
      inspectionRecords = await this.prisma.inspectionRecord.findMany({
        where: {
          ...siteFilterDirect,
          inspectedAt: { gte: monthStart, lte: monthEnd },
        },
        select: {
          inspectedByWorkerId: true,
          result: true,
          quantityChecked: true,
          quantityDefect: true,
        },
      });
    }

    // Inbound sessions (INBOUND_SUPPORT 트랙)
    let inboundSessions: Array<{
      id: string;
      status: string;
      totalQuantity: number;
      participants: Array<{ workerId: string }>;
    }> = [];
    if (track === 'INBOUND_SUPPORT') {
      inboundSessions = await this.prisma.inboundSession.findMany({
        where: {
          ...siteFilterDirect,
          sessionDate: { gte: monthStart, lte: monthEnd },
        },
        select: {
          id: true,
          status: true,
          totalQuantity: true,
          participants: { select: { workerId: true } },
        },
      });
    }

    // Dock sessions (DOCK_WRAP_GOAL 트랙)
    let dockSessions: Array<{
      id: string;
      status: string;
      wrapIncluded: boolean;
      totalQuantity: number;
      startedByWorkerId: string;
      participants: Array<{ workerId: string; role: string }>;
    }> = [];
    if (track === 'DOCK_WRAP_GOAL') {
      dockSessions = await this.prisma.dockSession.findMany({
        where: {
          ...siteFilterDirect,
          startedAt: { gte: monthStart, lte: monthEnd },
          status: 'ENDED',
        },
        select: {
          id: true,
          status: true,
          wrapIncluded: true,
          totalQuantity: true,
          startedByWorkerId: true,
          participants: { select: { workerId: true, role: true } },
        },
      });
    }

    // 작업자별 그룹핑 (시작자 + 참여자 모두 집계)
    const workerMap = new Map<string, TrackWorkerStats>();

    const initStats = (): TrackWorkerStats => ({
      totalCount: 0,
      totalVolume: 0,
      totalQuantity: 0,
      daysWorked: new Set(),
      teamworkCount: 0,
      voidCount: 0,
      editCount: 0,
      completedCount: 0,
      totalHoursWorked: 0,
      coworkerCount: 0,
      multiAssignmentCount: 0,
      inspectionsConducted: 0,
      inspectionDefects: 0,
      inspectionQuantity: 0,
      inboundSessionCount: 0,
      inboundApprovedQuantity: 0,
      dockSessionCount: 0,
      wrapSessionCount: 0,
    });

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

      // Calculate hours worked on this item
      const hoursWorked = item.endedAt && item.startedAt
        ? (item.endedAt.getTime() - item.startedAt.getTime()) / (1000 * 60 * 60)
        : 0;

      // Check for void/edit actions from audit logs
      const hasVoid = item.auditLogs.some((l) => l.action === 'VOID' || l.action === 'VOIDED');
      const hasEdit = item.auditLogs.some((l) => l.action === 'EDIT' || l.action === 'EDITED');

      for (const wId of relatedWorkerIds) {
        if (!workerMap.has(wId)) {
          workerMap.set(wId, initStats());
        }
        const stats = workerMap.get(wId)!;
        stats.totalCount += 1;
        stats.completedCount += 1;
        stats.totalVolume += Number(item.volume);
        stats.totalQuantity += Number(item.quantity);
        stats.daysWorked.add(dayKey);
        stats.totalHoursWorked += hoursWorked;
        if (hasVoid) stats.voidCount += 1;
        if (hasEdit) stats.editCount += 1;
        if (isTeamWork) {
          stats.teamworkCount += 1;
          stats.coworkerCount += relatedWorkerIds.size - 1;
        }
        if (relatedWorkerIds.size > 1 && item.assignments.length > 0) {
          stats.multiAssignmentCount += 1;
        }
      }
    }

    // Enrich with track-specific data
    if (track === 'INSPECTION_GOAL') {
      for (const rec of inspectionRecords) {
        if (!workerMap.has(rec.inspectedByWorkerId)) {
          workerMap.set(rec.inspectedByWorkerId, initStats());
        }
        const stats = workerMap.get(rec.inspectedByWorkerId)!;
        stats.inspectionsConducted += 1;
        stats.inspectionQuantity += rec.quantityChecked;
        stats.inspectionDefects += rec.quantityDefect;
      }
    }

    if (track === 'INBOUND_SUPPORT') {
      for (const session of inboundSessions) {
        for (const p of session.participants) {
          if (!workerMap.has(p.workerId)) {
            workerMap.set(p.workerId, initStats());
          }
          const stats = workerMap.get(p.workerId)!;
          stats.inboundSessionCount += 1;
          if (session.status === 'APPROVED') {
            stats.inboundApprovedQuantity += session.totalQuantity;
          }
        }
      }
    }

    if (track === 'DOCK_WRAP_GOAL') {
      for (const session of dockSessions) {
        const allWorkerIds = new Set<string>();
        allWorkerIds.add(session.startedByWorkerId);
        for (const p of session.participants) {
          allWorkerIds.add(p.workerId);
        }
        for (const wId of allWorkerIds) {
          if (!workerMap.has(wId)) {
            workerMap.set(wId, initStats());
          }
          const stats = workerMap.get(wId)!;
          stats.dockSessionCount += 1;
          if (session.wrapIncluded) {
            stats.wrapSessionCount += 1;
          }
        }
      }
    }

    // 전체 평균/최대 산출 (정규화 기준)
    const allStats = Array.from(workerMap.values());
    const avgCount =
      allStats.reduce((s, w) => s + w.completedCount, 0) / allStats.length || 1;
    const avgVolume =
      allStats.reduce((s, w) => s + w.totalVolume, 0) / allStats.length || 1;
    const maxDays = Math.max(...allStats.map((w) => w.daysWorked.size), 1);
    const maxTeamwork = Math.max(...allStats.map((w) => w.teamworkCount), 1);
    const maxInspections = Math.max(...allStats.map((w) => w.inspectionsConducted), 1);
    const maxInboundSessions = Math.max(...allStats.map((w) => w.inboundSessionCount), 1);
    const maxDockSessions = Math.max(...allStats.map((w) => w.dockSessionCount), 1);

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

      const entries: WorkerScoreData[] = [];

      for (const [workerId, stats] of workerMap.entries()) {
        const scored = this.calculateTrackScore(
          track,
          stats,
          weights,
          details,
          { avgCount, avgVolume, maxDays, maxTeamwork, maxInspections, maxInboundSessions, maxDockSessions },
        );

        entries.push({ workerId, ...scored });

        await tx.scoreEntry.create({
          data: {
            scoreRunId: run.id,
            workerId,
            track,
            performanceScore: scored.performanceScore,
            reliabilityScore: scored.reliabilityScore,
            teamworkScore: scored.teamworkScore,
            totalScore: scored.totalScore,
            details: JSON.stringify(scored.explanationJson),
          },
        });
      }

      // OUTBOUND_RANKED: 총점 기준 순위 부여
      if (track === 'OUTBOUND_RANKED') {
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
      `ScoreRun created: ${scoreRun.id} (${dto.month}, ${track}, ${workerMap.size} workers)`,
    );

    return this.getScoreRun(scoreRun.id);
  }

  // ======================== Track-Specific Scoring ========================

  /**
   * 트랙별 점수 계산 로직 + explanationJson 생성
   */
  private calculateTrackScore(
    track: string,
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    _details: Record<string, unknown>,
    norms: {
      avgCount: number;
      avgVolume: number;
      maxDays: number;
      maxTeamwork: number;
      maxInspections: number;
      maxInboundSessions: number;
      maxDockSessions: number;
    },
  ): Omit<WorkerScoreData, 'workerId'> {
    switch (track) {
      case 'OUTBOUND_RANKED':
        return this.scoreOutboundRanked(stats, weights, norms);
      case 'INSPECTION_GOAL':
        return this.scoreInspectionGoal(stats, weights, norms);
      case 'INBOUND_SUPPORT':
        return this.scoreInboundSupport(stats, weights, norms);
      case 'DOCK_WRAP_GOAL':
        return this.scoreDockWrapGoal(stats, weights, norms);
      default:
        return this.scoreGenericFallback(stats, weights, norms);
    }
  }

  /**
   * OUTBOUND_RANKED (상대평가)
   * Performance (60): completedCount(25) + efficiency CBM/h(20) + difficultyBonus(15)
   * Reliability (25): void_rate penalty + edit_rate penalty + completion_rate
   * Teamwork (15): coworker_count bonus + multi_assignment bonus
   */
  private scoreOutboundRanked(
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    norms: { avgCount: number; avgVolume: number; maxDays: number; maxTeamwork: number },
  ): Omit<WorkerScoreData, 'workerId'> {
    // -- Performance (내부 비중: completedCount 25, efficiency 20, difficulty 15 = total 60)
    const countScore = Number(Math.min((stats.completedCount / norms.avgCount) * 25, 25).toFixed(2));
    const efficiency = stats.totalHoursWorked > 0
      ? stats.totalVolume / stats.totalHoursWorked
      : 0;
    const avgEfficiency = norms.avgVolume / (norms.avgCount > 0 ? norms.avgCount * 2 : 1); // rough hourly avg
    const efficiencyScore = Number(Math.min(
      avgEfficiency > 0 ? (efficiency / avgEfficiency) * 20 : 20,
      20,
    ).toFixed(2));
    // Difficulty bonus: based on volume per item ratio vs average (proxy for difficulty)
    const avgVolumePerItem = norms.avgVolume / norms.avgCount || 1;
    const workerVolumePerItem = stats.completedCount > 0 ? stats.totalVolume / stats.completedCount : 0;
    const difficultyMultiplier = workerVolumePerItem / avgVolumePerItem || 1;
    const difficultyBonusScore = Number(Math.min(difficultyMultiplier * 15, 15).toFixed(2));
    const performanceRaw = countScore + efficiencyScore + difficultyBonusScore;
    const performanceScore = Number(Math.min(performanceRaw, 100).toFixed(2));

    // -- Reliability (내부 비중: 25)
    const voidRate = stats.totalCount > 0 ? stats.voidCount / stats.totalCount : 0;
    const editRate = stats.totalCount > 0 ? stats.editCount / stats.totalCount : 0;
    const completionRate = stats.daysWorked.size / norms.maxDays;
    const voidPenalty = Number((voidRate * 10).toFixed(2)); // max -10
    const editPenalty = Number((editRate * 5).toFixed(2)); // max -5
    const completionScore = Number(Math.min(completionRate * 25, 25).toFixed(2));
    const reliabilityRaw = Math.max(completionScore - voidPenalty - editPenalty, 0);
    const reliabilityScore = Number(Math.min(reliabilityRaw, 100).toFixed(2));

    // -- Teamwork (내부 비중: 15)
    const coworkerBonus = Number(Math.min(stats.coworkerCount * 0.5, 7.5).toFixed(2));
    const multiAssignmentBonus = Number(Math.min(stats.multiAssignmentCount * 1.0, 7.5).toFixed(2));
    const teamworkRaw = coworkerBonus + multiAssignmentBonus;
    const teamworkScore = Number(Math.min(teamworkRaw, 100).toFixed(2));

    // 가중 합산
    const totalScore = Number(
      (
        (performanceScore * weights.performance) / 100 +
        (reliabilityScore * weights.reliability) / 100 +
        (teamworkScore * weights.teamwork) / 100
      ).toFixed(2),
    );

    const explanationJson: ScoreExplanation = {
      track: 'OUTBOUND_RANKED',
      performance: {
        total: performanceScore,
        completedCount: { value: stats.completedCount, score: countScore },
        efficiency: { value: Number(efficiency.toFixed(2)), unit: 'CBM/h', score: efficiencyScore },
        difficultyBonus: { value: Number(difficultyMultiplier.toFixed(2)), score: difficultyBonusScore },
      },
      reliability: {
        total: reliabilityScore,
        voidRate: { value: Number(voidRate.toFixed(4)), penalty: -voidPenalty },
        editRate: { value: Number(editRate.toFixed(4)), penalty: -editPenalty },
        completionRate: { value: Number(completionRate.toFixed(4)), score: completionScore },
      },
      teamwork: {
        total: teamworkScore,
        coworkerSessions: stats.coworkerCount,
        multiAssignments: stats.multiAssignmentCount,
      },
    };

    return { performanceScore, reliabilityScore, teamworkScore, totalScore, explanationJson };
  }

  /**
   * INSPECTION_GOAL (절대평가)
   * Performance (60): coverage vs target + accuracy vs target + SLA vs target
   * Reliability (25): same pattern (void/edit/completion)
   * Teamwork (15): support contribution
   */
  private scoreInspectionGoal(
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    norms: { maxDays: number; maxInspections: number },
  ): Omit<WorkerScoreData, 'workerId'> {
    // Performance
    const coverageScore = Number(Math.min(
      norms.maxInspections > 0
        ? (stats.inspectionsConducted / norms.maxInspections) * 25
        : 25,
      25,
    ).toFixed(2));
    const accuracy = stats.inspectionQuantity > 0
      ? 1 - (stats.inspectionDefects / stats.inspectionQuantity)
      : 1;
    const accuracyScore = Number(Math.min(accuracy * 20, 20).toFixed(2));
    const slaScore = Number(Math.min(
      (stats.daysWorked.size / norms.maxDays) * 15,
      15,
    ).toFixed(2));
    const performanceScore = Number(Math.min(coverageScore + accuracyScore + slaScore, 100).toFixed(2));

    // Reliability
    const voidRate = stats.totalCount > 0 ? stats.voidCount / stats.totalCount : 0;
    const editRate = stats.totalCount > 0 ? stats.editCount / stats.totalCount : 0;
    const completionRate = stats.daysWorked.size / norms.maxDays;
    const voidPenalty = Number((voidRate * 10).toFixed(2));
    const editPenalty = Number((editRate * 5).toFixed(2));
    const completionScore = Number(Math.min(completionRate * 25, 25).toFixed(2));
    const reliabilityScore = Number(Math.min(Math.max(completionScore - voidPenalty - editPenalty, 0), 100).toFixed(2));

    // Teamwork: support contribution (inspections that helped other workers)
    const supportScore = Number(Math.min(stats.teamworkCount * 1.5, 15).toFixed(2));
    const teamworkScore = Number(Math.min(supportScore, 100).toFixed(2));

    const totalScore = Number(
      (
        (performanceScore * weights.performance) / 100 +
        (reliabilityScore * weights.reliability) / 100 +
        (teamworkScore * weights.teamwork) / 100
      ).toFixed(2),
    );

    const explanationJson: ScoreExplanation = {
      track: 'INSPECTION_GOAL',
      performance: {
        total: performanceScore,
        coverage: { value: stats.inspectionsConducted, target: norms.maxInspections, score: coverageScore },
        accuracy: { value: Number(accuracy.toFixed(4)), score: accuracyScore },
        sla: { value: stats.daysWorked.size, target: norms.maxDays, score: slaScore },
      },
      reliability: {
        total: reliabilityScore,
        voidRate: { value: Number(voidRate.toFixed(4)), penalty: -voidPenalty },
        editRate: { value: Number(editRate.toFixed(4)), penalty: -editPenalty },
        completionRate: { value: Number(completionRate.toFixed(4)), score: completionScore },
      },
      teamwork: {
        total: teamworkScore,
        supportContribution: stats.teamworkCount,
      },
    };

    return { performanceScore, reliabilityScore, teamworkScore, totalScore, explanationJson };
  }

  /**
   * INBOUND_SUPPORT (세션 기여)
   * Performance (60): session participation + approved quantity contribution
   * Reliability (25): same pattern
   * Teamwork (15): session teamwork
   */
  private scoreInboundSupport(
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    norms: { maxDays: number; maxInboundSessions: number; avgCount: number },
  ): Omit<WorkerScoreData, 'workerId'> {
    // Performance
    const sessionParticipationScore = Number(Math.min(
      norms.maxInboundSessions > 0
        ? (stats.inboundSessionCount / norms.maxInboundSessions) * 30
        : 30,
      30,
    ).toFixed(2));
    const avgApprovedQty =
      norms.avgCount > 0
        ? Array.from({ length: 1 }).reduce(() => stats.inboundApprovedQuantity, 0) as number
        : 1;
    const quantityContributionScore = Number(Math.min(
      stats.inboundApprovedQuantity > 0 ? 30 : 0,
      30,
    ).toFixed(2));
    const performanceScore = Number(Math.min(sessionParticipationScore + quantityContributionScore, 100).toFixed(2));

    // Reliability
    const voidRate = stats.totalCount > 0 ? stats.voidCount / stats.totalCount : 0;
    const editRate = stats.totalCount > 0 ? stats.editCount / stats.totalCount : 0;
    const completionRate = stats.daysWorked.size / norms.maxDays;
    const voidPenalty = Number((voidRate * 10).toFixed(2));
    const editPenalty = Number((editRate * 5).toFixed(2));
    const completionScore = Number(Math.min(completionRate * 25, 25).toFixed(2));
    const reliabilityScore = Number(Math.min(Math.max(completionScore - voidPenalty - editPenalty, 0), 100).toFixed(2));

    // Teamwork: session teamwork (multi-participant sessions)
    const sessionTeamworkScore = Number(Math.min(stats.teamworkCount * 1.5, 15).toFixed(2));
    const teamworkScore = Number(Math.min(sessionTeamworkScore, 100).toFixed(2));

    const totalScore = Number(
      (
        (performanceScore * weights.performance) / 100 +
        (reliabilityScore * weights.reliability) / 100 +
        (teamworkScore * weights.teamwork) / 100
      ).toFixed(2),
    );

    const explanationJson: ScoreExplanation = {
      track: 'INBOUND_SUPPORT',
      performance: {
        total: performanceScore,
        sessionParticipation: { value: stats.inboundSessionCount, score: sessionParticipationScore },
        approvedQuantity: { value: stats.inboundApprovedQuantity, score: quantityContributionScore },
      },
      reliability: {
        total: reliabilityScore,
        voidRate: { value: Number(voidRate.toFixed(4)), penalty: -voidPenalty },
        editRate: { value: Number(editRate.toFixed(4)), penalty: -editPenalty },
        completionRate: { value: Number(completionRate.toFixed(4)), score: completionScore },
      },
      teamwork: {
        total: teamworkScore,
        sessionTeamwork: stats.teamworkCount,
      },
    };

    return { performanceScore, reliabilityScore, teamworkScore, totalScore, explanationJson };
  }

  /**
   * DOCK_WRAP_GOAL (절대평가)
   * Performance (60): dock sessions completed + wrap quality
   * Reliability (25): same pattern
   * Teamwork (15): support contribution
   */
  private scoreDockWrapGoal(
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    norms: { maxDays: number; maxDockSessions: number },
  ): Omit<WorkerScoreData, 'workerId'> {
    // Performance
    const dockScore = Number(Math.min(
      norms.maxDockSessions > 0
        ? (stats.dockSessionCount / norms.maxDockSessions) * 35
        : 35,
      35,
    ).toFixed(2));
    const wrapQualityScore = Number(Math.min(
      stats.dockSessionCount > 0
        ? (stats.wrapSessionCount / stats.dockSessionCount) * 25
        : 0,
      25,
    ).toFixed(2));
    const performanceScore = Number(Math.min(dockScore + wrapQualityScore, 100).toFixed(2));

    // Reliability
    const voidRate = stats.totalCount > 0 ? stats.voidCount / stats.totalCount : 0;
    const editRate = stats.totalCount > 0 ? stats.editCount / stats.totalCount : 0;
    const completionRate = stats.daysWorked.size / norms.maxDays;
    const voidPenalty = Number((voidRate * 10).toFixed(2));
    const editPenalty = Number((editRate * 5).toFixed(2));
    const completionScore = Number(Math.min(completionRate * 25, 25).toFixed(2));
    const reliabilityScore = Number(Math.min(Math.max(completionScore - voidPenalty - editPenalty, 0), 100).toFixed(2));

    // Teamwork: support contribution
    const supportScore = Number(Math.min(stats.teamworkCount * 1.5, 15).toFixed(2));
    const teamworkScore = Number(Math.min(supportScore, 100).toFixed(2));

    const totalScore = Number(
      (
        (performanceScore * weights.performance) / 100 +
        (reliabilityScore * weights.reliability) / 100 +
        (teamworkScore * weights.teamwork) / 100
      ).toFixed(2),
    );

    const explanationJson: ScoreExplanation = {
      track: 'DOCK_WRAP_GOAL',
      performance: {
        total: performanceScore,
        dockSessions: { value: stats.dockSessionCount, score: dockScore },
        wrapQuality: { value: stats.wrapSessionCount, score: wrapQualityScore },
      },
      reliability: {
        total: reliabilityScore,
        voidRate: { value: Number(voidRate.toFixed(4)), penalty: -voidPenalty },
        editRate: { value: Number(editRate.toFixed(4)), penalty: -editPenalty },
        completionRate: { value: Number(completionRate.toFixed(4)), score: completionScore },
      },
      teamwork: {
        total: teamworkScore,
        supportContribution: stats.teamworkCount,
      },
    };

    return { performanceScore, reliabilityScore, teamworkScore, totalScore, explanationJson };
  }

  /**
   * Generic fallback for unknown tracks (preserves original scoring logic)
   */
  private scoreGenericFallback(
    stats: TrackWorkerStats,
    weights: { performance: number; reliability: number; teamwork: number },
    norms: { avgCount: number; avgVolume: number; maxDays: number },
  ): Omit<WorkerScoreData, 'workerId'> {
    const countRatio = stats.totalCount / norms.avgCount;
    const volumeRatio = norms.avgVolume > 0 ? stats.totalVolume / norms.avgVolume : 1;
    const performanceRaw = (countRatio * 0.5 + volumeRatio * 0.5) * 100;
    const performanceScore = Number(Math.min(performanceRaw, 100).toFixed(2));

    const reliabilityRaw = (stats.daysWorked.size / norms.maxDays) * 100;
    const reliabilityScore = Number(Math.min(reliabilityRaw, 100).toFixed(2));

    const teamworkRaw = stats.totalCount > 0
      ? (stats.teamworkCount / stats.totalCount) * 100
      : 0;
    const teamworkScore = Number(Math.min(teamworkRaw, 100).toFixed(2));

    const totalScore = Number(
      (
        (performanceScore * weights.performance) / 100 +
        (reliabilityScore * weights.reliability) / 100 +
        (teamworkScore * weights.teamwork) / 100
      ).toFixed(2),
    );

    const explanationJson: ScoreExplanation = {
      track: 'GENERIC',
      performance: {
        total: performanceScore,
        countRatio: { value: Number(countRatio.toFixed(2)), score: Number((countRatio * 50).toFixed(2)) },
        volumeRatio: { value: Number(volumeRatio.toFixed(2)), score: Number((volumeRatio * 50).toFixed(2)) },
      },
      reliability: {
        total: reliabilityScore,
        completionRate: { value: Number((stats.daysWorked.size / norms.maxDays).toFixed(4)), score: reliabilityScore },
      },
      teamwork: {
        total: teamworkScore,
        coworkerSessions: stats.teamworkCount,
      },
    };

    return { performanceScore, reliabilityScore, teamworkScore, totalScore, explanationJson };
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
   * - ScoreRun 상태를 FROZEN으로 변경
   * - frozenAt 기록
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
   * - OPEN 상태의 이의신청이 있으면 확정 불가
   * - finalizedAt 기록
   */
  async finalizeScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id },
      include: {
        entries: { select: { id: true } },
      },
    });
    if (!run) {
      throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    }
    if (run.status !== 'FROZEN') {
      throw new BadRequestException('동결 상태의 실행만 확정할 수 있습니다');
    }

    // OPEN 이의신청 확인 — 이 실행의 엔트리에 연결된 미처리 이의신청이 있으면 거부
    const entryIds = run.entries.map((e) => e.id);
    if (entryIds.length > 0) {
      const openObjections = await this.prisma.objectionCase.count({
        where: {
          scoreEntryId: { in: entryIds },
          status: { in: ['OPEN', 'REVIEWING'] },
        },
      });

      if (openObjections > 0) {
        throw new BadRequestException(
          `미처리 이의신청이 ${openObjections}건 있습니다. 모든 이의신청을 처리한 후 확정해주세요.`,
        );
      }
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

  /**
   * 이의신청 후 재산출
   * 1. 해당 실행의 ACCEPTED 이의신청 확인
   * 2. 새 SHADOW 실행을 동일 policyVersion으로 생성
   * 3. 전체 재계산
   */
  async recalculateAfterObjection(scoreRunId: string) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id: scoreRunId },
      include: {
        policyVersion: true,
        entries: { select: { id: true } },
      },
    });
    if (!run) {
      throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    }

    // ACCEPTED 이의신청 확인
    const entryIds = run.entries.map((e) => e.id);
    let acceptedCount = 0;
    if (entryIds.length > 0) {
      acceptedCount = await this.prisma.objectionCase.count({
        where: {
          scoreEntryId: { in: entryIds },
          status: 'ACCEPTED',
        },
      });
    }

    if (acceptedCount === 0) {
      throw new BadRequestException('수락된 이의신청이 없어 재산출이 필요하지 않습니다');
    }

    this.logger.log(
      `Recalculating ScoreRun ${scoreRunId}: ${acceptedCount} accepted objections found`,
    );

    // 새 SHADOW 실행을 동일 policyVersion + month로 생성
    const newRun = await this.createScoreRun(run.siteId, {
      policyVersionId: run.policyVersionId,
      month: run.month,
    });

    this.logger.log(
      `Recalculated ScoreRun created: ${typeof newRun === 'object' && newRun !== null && 'id' in newRun ? (newRun as { id: string }).id : 'unknown'} (from ${scoreRunId})`,
    );

    return newRun;
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

  // ======================== Policy Pack Templates ========================

  /**
   * 정책 팩 템플릿 목록 조회
   */
  async getPolicyPackTemplates() {
    const templates = await this.prisma.policyPackTemplate.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: templates.map((t) => ({
        ...t,
        tracks: typeof t.tracks === 'string' ? JSON.parse(t.tracks) : t.tracks,
      })),
    };
  }

  /**
   * 정책 팩 적용 - 팩의 모든 트랙에 대해 PolicyVersion을 생성
   */
  async applyPolicyPack(templateId: string, siteId: string) {
    const template = await this.prisma.policyPackTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new NotFoundException('정책 팩 템플릿을 찾을 수 없습니다');
    }

    const trackConfigs = typeof template.tracks === 'string'
      ? JSON.parse(template.tracks)
      : template.tracks;

    if (!Array.isArray(trackConfigs) || trackConfigs.length === 0) {
      throw new BadRequestException('정책 팩에 트랙 설정이 없습니다');
    }

    // 기존 ACTIVE/SHADOW 정책들을 RETIRED로 전환
    await this.prisma.policyVersion.updateMany({
      where: {
        siteId,
        status: { in: ['ACTIVE', 'SHADOW'] },
      },
      data: {
        status: 'RETIRED',
        effectiveTo: new Date(),
      },
    });

    const created: unknown[] = [];
    for (const cfg of trackConfigs) {
      const pv = await this.prisma.policyVersion.create({
        data: {
          siteId,
          name: `[${template.name}] ${cfg.name || cfg.track}`,
          description: `정책 팩 "${template.name}"에서 자동 생성됨`,
          track: cfg.track,
          weights: JSON.stringify(cfg.weights),
          status: 'SHADOW',
          effectiveFrom: new Date(),
        },
      });
      created.push(pv);
    }

    this.logger.log(
      `PolicyPack ${template.code} applied to site ${siteId}: ${created.length} policies created`,
    );

    return {
      message: `정책 팩 "${template.name}"이(가) 적용되었습니다. ${created.length}개 트랙 정책이 SHADOW 상태로 생성되었습니다.`,
      policies: created,
    };
  }

  // ======================== Payout Dry-run ========================

  /**
   * 지급 시뮬레이션 (Dry-run)
   * scoreRunId의 모든 점수 엔트리를 기반으로 예상 지급액을 계산
   */
  async generatePayoutDryRun(scoreRunId: string, baseIncentive: number = 500000) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id: scoreRunId },
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

    const payoutData = run.entries.map((entry) => {
      const totalScore = Number(entry.totalScore) || 0;
      const estimatedPayout = Math.round(baseIncentive * (totalScore / 100));
      return {
        workerId: entry.worker.id,
        workerName: entry.worker.name,
        employeeCode: entry.worker.employeeCode,
        track: entry.track,
        performanceScore: Number(entry.performanceScore) || 0,
        reliabilityScore: Number(entry.reliabilityScore) || 0,
        teamworkScore: Number(entry.teamworkScore) || 0,
        totalScore,
        rank: entry.rank,
        estimatedPayout,
      };
    });

    const totalPayout = payoutData.reduce((sum, p) => sum + p.estimatedPayout, 0);

    return {
      scoreRunId: run.id,
      month: run.month,
      status: run.status,
      policyName: run.policyVersion?.name || '-',
      track: run.policyVersion?.track || '-',
      baseIncentive,
      totalPayout,
      workerCount: payoutData.length,
      data: payoutData,
    };
  }
}
