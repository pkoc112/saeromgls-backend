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
import {
  safeDiv, clamp, fix2, resolveTrack, getGrade, scaleBands, readPolicyConfig,
  MIN_WORKERS, MIN_DAYS_WORKED, WORKING_DAYS, VALID_TRACKS, TRACK_MIGRATION, DEFAULT_PAYOUT_BANDS,
} from './incentive-utils';

// ════════════════════════════════════════════════════════════════
// 인센티브 점수 엔진 v3
// ── 4트랙 · 절대평가 · 등급형 지급 · 안전게이트 ──
// ════════════════════════════════════════════════════════════════

// 절대 기준선 (PolicyVersion.details로 사이트별 오버라이드)
const BASELINES = {
  outbound: { throughputPerDay: 15, volumePerMonth: 50 },
  inbound_dock: { sessionBaseline: 20, qtyBaseline: 5000, outboundVolumeBaseline: 30 },
  inspection: { baseline: 40, coverageBaseline: 2000, targetDefectRate: 0.03 },
  manager: { teamScoreBaseline: 60, exceptionBaseline: 10 },
};

// ── 타입 ────────────────────────────────────────────────────────
interface ExplanationPerformance { total: number; [key: string]: unknown; }
interface ExplanationReliability { total: number; [key: string]: unknown; }
interface ExplanationTeamwork { total: number; [key: string]: unknown; }
interface ScoreExplanation { track: string; performance: ExplanationPerformance; reliability: ExplanationReliability; teamwork: ExplanationTeamwork; safetyGate?: { passed: boolean; violations: string[] }; }
interface WorkerScoreData { workerId: string; performanceScore: number; reliabilityScore: number; teamworkScore: number; totalScore: number; grade: string; estimatedPayout: number; explanationJson: ScoreExplanation; }

interface WorkerStats {
  totalCount: number;
  totalVolume: number;
  totalQuantity: number;
  daysWorked: Set<string>;
  teamworkCount: number;
  voidCount: number;
  editCount: number;
  completedCount: number;
  totalHoursWorked: number;
  coworkerCount: number;
  multiAssignmentCount: number;
  // Inspection
  inspectionsConducted: number;
  inspectionDefects: number;
  inspectionQuantity: number;
  // Inbound (입고+상하차 통합)
  inboundSessionCount: number;
  inboundApprovedQuantity: number;
  inboundDiffQuantity: number;
  // Manager
  managedWorkerAvgScore: number;
  exceptionsHandled: number;
  teamTotalVoids: number;
  teamTotalItems: number;
}

type Weights = { performance: number; reliability: number; teamwork: number };
type Baselines = Record<string, unknown>;

@Injectable()
export class IncentivesService {
  private readonly logger = new Logger(IncentivesService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ════════════════════════════════════════════════════════════════
  // Policy Versions
  // ════════════════════════════════════════════════════════════════

  async getPolicyVersions(siteId: string | undefined, params?: QueryPolicyDto) {
    const where: Prisma.PolicyVersionWhereInput = {};
    if (siteId) where.siteId = siteId;
    if (params?.status) where.status = params.status;
    if (params?.track) where.track = params.track;
    const data = await this.prisma.policyVersion.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { data };
  }

  async createPolicyVersion(dto: CreatePolicyDto, siteId: string) {
    let parsedWeights: { performance?: number; reliability?: number; teamwork?: number };
    try { parsedWeights = JSON.parse(dto.weights); } catch { throw new BadRequestException('가중치 JSON 형식이 올바르지 않습니다'); }
    const { performance = 0, reliability = 0, teamwork = 0 } = parsedWeights;
    if (performance + reliability + teamwork !== 100) {
      throw new BadRequestException(`가중치 합계가 100이어야 합니다 (현재: ${performance + reliability + teamwork})`);
    }
    if (dto.details) { try { JSON.parse(dto.details); } catch { throw new BadRequestException('세부 JSON 형식이 올바르지 않습니다'); } }
    const pv = await this.prisma.policyVersion.create({
      data: { siteId, name: dto.name, track: dto.track, weights: dto.weights, details: dto.details, description: dto.description, status: 'DRAFT' },
    });
    this.logger.log(`PolicyVersion created: ${pv.id} (${dto.track})`);
    return pv;
  }

  async updatePolicyStatus(id: string, status: string) {
    const validStatuses = ['DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED'];
    if (!validStatuses.includes(status)) throw new BadRequestException(`유효하지 않은 상태입니다. 허용: ${validStatuses.join(', ')}`);
    const policy = await this.prisma.policyVersion.findUnique({ where: { id } });
    if (!policy) throw new NotFoundException('정책 버전을 찾을 수 없습니다');
    const transitions: Record<string, string[]> = { DRAFT: ['SHADOW', 'RETIRED'], SHADOW: ['ACTIVE', 'DRAFT', 'RETIRED'], ACTIVE: ['RETIRED'], RETIRED: [] };
    const allowed = transitions[policy.status] || [];
    if (!allowed.includes(status)) throw new BadRequestException(`${policy.status}에서 ${status}로 변경할 수 없습니다. 허용: ${allowed.join(', ') || '없음'}`);
    // 같은 트랙의 기존 ACTIVE → RETIRED (구버전 트랙명도 매핑)
    if (status === 'ACTIVE') {
      const resolvedTrack = resolveTrack(policy.track);
      const trackVariants = Object.entries(TRACK_MIGRATION)
        .filter(([, v]) => v === resolvedTrack)
        .map(([k]) => k);
      trackVariants.push(resolvedTrack);
      await this.prisma.policyVersion.updateMany({
        where: { siteId: policy.siteId, track: { in: trackVariants }, status: 'ACTIVE', id: { not: id } },
        data: { status: 'RETIRED', effectiveTo: new Date() },
      });
    }
    const updated = await this.prisma.policyVersion.update({
      where: { id },
      data: { status, effectiveFrom: status === 'ACTIVE' ? new Date() : policy.effectiveFrom, effectiveTo: status === 'RETIRED' ? new Date() : policy.effectiveTo },
    });
    this.logger.log(`PolicyVersion ${id} status: ${policy.status} -> ${status}`);
    return updated;
  }

  // ════════════════════════════════════════════════════════════════
  // Score Run — 4트랙 절대평가 엔진 v3
  // ════════════════════════════════════════════════════════════════

  async createScoreRun(siteId: string, dto: CreateScoreRunDto) {
    const policyVersion = await this.prisma.policyVersion.findUnique({ where: { id: dto.policyVersionId } });
    if (!policyVersion) throw new NotFoundException('정책 버전을 찾을 수 없습니다');
    if (!['ACTIVE', 'SHADOW'].includes(policyVersion.status)) {
      throw new BadRequestException('ACTIVE 또는 SHADOW 상태의 정책만 실행할 수 있습니다');
    }

    // 중복 방지 (트랜잭션 밖 사전 체크 — UX용)
    const existingRun = await this.prisma.scoreRun.findFirst({
      where: { siteId, policyVersionId: dto.policyVersionId, month: dto.month, status: { notIn: ['FINALIZED'] } },
    });
    if (existingRun) {
      throw new BadRequestException(`동일 월(${dto.month})/정책으로 진행 중인 실행이 있습니다 (ID: ${existingRun.id})`);
    }

    // 가중치
    let weights: Weights;
    try { weights = JSON.parse(policyVersion.weights); } catch { throw new BadRequestException('가중치 JSON 파싱 실패'); }

    // 세부 설정 (baselines, payoutBands, workingDays, minWorkers 등 사이트별 오버라이드)
    let policyDetails: Baselines = {};
    if (policyVersion.details) {
      try { policyDetails = JSON.parse(policyVersion.details); } catch { /* ignore */ }
    }
    const cfg = readPolicyConfig(policyDetails);
    const payoutBands = cfg.payoutBands;
    // baselines에 workingDays 주입 (scoreOutbound/scoreInbound 등에서 사용)
    (policyDetails as any).__workingDays = cfg.workingDays;

    // 트랙 해석 (구버전 호환)
    const track = resolveTrack(policyVersion.track);

    const monthStart = kstStartOfDay(`${dto.month}-01`);
    const lastDay = new Date(Number(dto.month.split('-')[0]), Number(dto.month.split('-')[1]), 0).getDate();
    const monthEnd = kstEndOfDay(`${dto.month}-${String(lastDay).padStart(2, '0')}`);
    const siteFilterDirect = siteId ? { siteId } : {};

    // 해당 트랙의 jobTrack을 가진 작업자 ID 목록 (신+구 트랙 호환)
    const trackAliases: Record<string, string[]> = {
      OUTBOUND: ['OUTBOUND', 'OUTBOUND_RANKED'],
      INBOUND_DOCK: ['INBOUND_DOCK', 'INBOUND_SUPPORT', 'DOCK_WRAP_GOAL'],
      INSPECTION: ['INSPECTION', 'INSPECTION_GOAL'],
      MANAGER: ['MANAGER', 'MANAGER_OPS'],
    };
    const acceptedJobTracks = trackAliases[track] || [track];
    const eligibleWorkers = await this.prisma.worker.findMany({
      where: {
        jobTrack: { in: acceptedJobTracks },
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
      },
      select: { id: true },
    });
    const eligibleWorkerIds = new Set(eligibleWorkers.map((w) => w.id));
    this.logger.log(`Track ${track}: ${eligibleWorkerIds.size} eligible workers by jobTrack`);

    // ── 데이터 수집 ──

    // 1. 작업 기록 (출고 + 모든 참여)
    const workItems = await this.prisma.workItem.findMany({
      where: {
        status: 'ENDED', scoreEligible: true,
        endedAt: { gte: monthStart, lte: monthEnd },
        startedByWorker: siteId ? { OR: [{ siteId }, { siteId: null }] } : undefined,
      },
      include: {
        startedByWorker: { select: { id: true, name: true, siteId: true } },
        assignments: { select: { workerId: true } },
        auditLogs: { select: { action: true } },
      },
    });

    // 2. 검수 기록
    let inspectionRecords: Array<{ inspectedByWorkerId: string; result: string; quantityChecked: number; quantityDefect: number }> = [];
    if (track === 'INSPECTION') {
      inspectionRecords = await this.prisma.inspectionRecord.findMany({
        where: { ...siteFilterDirect, inspectedAt: { gte: monthStart, lte: monthEnd } },
        select: { inspectedByWorkerId: true, result: true, quantityChecked: true, quantityDefect: true },
      });
    }

    // 3. 입고 세션 (INBOUND_DOCK 트랙에서 사용 — 상하차 데이터 대체)
    let inboundSessions: Array<{ id: string; status: string; totalQuantity: number; diffQuantity: number; participants: Array<{ workerId: string }> }> = [];
    if (track === 'INBOUND_DOCK') {
      inboundSessions = await this.prisma.inboundSession.findMany({
        where: { ...siteFilterDirect, sessionDate: { gte: monthStart, lte: monthEnd } },
        select: { id: true, status: true, totalQuantity: true, diffQuantity: true, participants: { select: { workerId: true } } },
      });
    }

    // ── 작업자별 통계 ──

    const workerMap = new Map<string, WorkerStats>();
    const initStats = (): WorkerStats => ({
      totalCount: 0, totalVolume: 0, totalQuantity: 0, daysWorked: new Set(),
      teamworkCount: 0, voidCount: 0, editCount: 0, completedCount: 0,
      totalHoursWorked: 0, coworkerCount: 0, multiAssignmentCount: 0,
      inspectionsConducted: 0, inspectionDefects: 0, inspectionQuantity: 0,
      inboundSessionCount: 0, inboundApprovedQuantity: 0, inboundDiffQuantity: 0,
      managedWorkerAvgScore: 0, exceptionsHandled: 0, teamTotalVoids: 0, teamTotalItems: 0,
    });

    // MANAGER 트랙은 관리자가 WorkItem에 직접 참여하지 않을 수 있으므로,
    // eligible worker를 미리 등록해서 팀 성과 기반으로 채점 가능하게 함
    if (track === 'MANAGER') {
      for (const wid of eligibleWorkerIds) {
        if (!workerMap.has(wid)) workerMap.set(wid, initStats());
      }
    }

    for (const item of workItems) {
      const relatedIds = new Set<string>();
      relatedIds.add(item.startedByWorkerId);
      for (const a of item.assignments) relatedIds.add(a.workerId);
      const isTeam = relatedIds.size > 1;
      const dayKey = item.endedAt ? item.endedAt.toISOString().split('T')[0] : item.startedAt.toISOString().split('T')[0];
      // 순수 작업시간: 일시정지 시간 차감
      let rawMs = item.endedAt && item.startedAt ? (item.endedAt.getTime() - item.startedAt.getTime()) : 0;
      if (rawMs > 0 && (item as any).notes) {
        try {
          const parsed = JSON.parse((item as any).notes);
          if (Array.isArray(parsed?.pauseHistory)) {
            for (const e of parsed.pauseHistory) {
              const pAt = e.pausedAt ? new Date(e.pausedAt).getTime() : 0;
              const rAt = e.resumedAt ? new Date(e.resumedAt).getTime() : (item.endedAt ? item.endedAt.getTime() : Date.now());
              if (pAt > 0 && rAt > pAt) rawMs -= (rAt - pAt);
            }
          }
        } catch { /* ignore */ }
      }
      const hours = Math.max(0, rawMs) / 3600000;
      const hasVoid = item.auditLogs.some((l) => l.action === 'VOID' || l.action === 'VOIDED');
      const hasEdit = item.auditLogs.some((l) => l.action === 'EDIT' || l.action === 'EDITED');

      for (const wId of relatedIds) {
        if (!workerMap.has(wId)) workerMap.set(wId, initStats());
        const s = workerMap.get(wId)!;
        s.totalCount += 1; s.completedCount += 1;
        s.totalVolume += Number(item.volume); s.totalQuantity += Number(item.quantity);
        s.daysWorked.add(dayKey); s.totalHoursWorked += hours;
        if (hasVoid) s.voidCount += 1;
        if (hasEdit) s.editCount += 1;
        if (isTeam) { s.teamworkCount += 1; s.coworkerCount += relatedIds.size - 1; }
        if (relatedIds.size > 1 && item.assignments.length > 0) s.multiAssignmentCount += 1;
      }
    }

    // 검수 보강
    if (track === 'INSPECTION') {
      for (const rec of inspectionRecords) {
        if (!workerMap.has(rec.inspectedByWorkerId)) workerMap.set(rec.inspectedByWorkerId, initStats());
        const s = workerMap.get(rec.inspectedByWorkerId)!;
        s.inspectionsConducted += 1; s.inspectionQuantity += rec.quantityChecked; s.inspectionDefects += rec.quantityDefect;
      }
    }

    // 입고 보강 (입고+상하차 통합)
    if (track === 'INBOUND_DOCK') {
      for (const sess of inboundSessions) {
        for (const p of sess.participants) {
          if (!workerMap.has(p.workerId)) workerMap.set(p.workerId, initStats());
          const s = workerMap.get(p.workerId)!;
          s.inboundSessionCount += 1;
          if (sess.status === 'APPROVED') {
            s.inboundApprovedQuantity += sess.totalQuantity;
            s.inboundDiffQuantity += Math.abs(sess.diffQuantity);
          }
        }
      }
    }

    // eligible 작업자만 세서 최소 표본 체크
    const eligibleCount = eligibleWorkerIds.size > 0
      ? [...workerMap.keys()].filter((id) => eligibleWorkerIds.has(id)).length
      : workerMap.size;
    if (track !== 'MANAGER' && eligibleCount < cfg.minWorkers) {
      throw new BadRequestException(`최소 ${cfg.minWorkers}명 이상 필요합니다 (현재: ${eligibleCount}명, 트랙: ${track})`);
    }
    if (eligibleCount === 0 && workerMap.size > 0) {
      const trackNames: Record<string, string> = {
        OUTBOUND: '출고 전담', INBOUND_DOCK: '입고·상하차', INSPECTION: '검수 전담', MANAGER: '현장 관리자',
      };
      throw new BadRequestException(
        `${dto.month}에 ${trackNames[track] || track} 트랙 작업자가 없습니다. 작업자 관리에서 직무트랙을 ${trackNames[track] || track}으로 설정해주세요.`,
      );
    }
    if (workerMap.size === 0) {
      const trackNames: Record<string, string> = {
        OUTBOUND: '출고 전담', INBOUND_DOCK: '입고·상하차', INSPECTION: '검수 전담', MANAGER: '현장 관리자',
      };
      throw new BadRequestException(
        `${dto.month}에 ${trackNames[track] || track} 트랙 작업 기록이 없습니다.`,
      );
    }

    // ── 트랜잭션 (Serializable + 재검증으로 레이스 컨디션 차단) ──
    const scoreRun = await this.prisma.$transaction(async (tx) => {
      // 트랜잭션 내부 재검증: 다른 요청이 동시에 생성 중일 수 있음
      const duplicateInTx = await tx.scoreRun.findFirst({
        where: { siteId, policyVersionId: dto.policyVersionId, month: dto.month, status: { notIn: ['FINALIZED'] } },
      });
      if (duplicateInTx) {
        throw new BadRequestException(`동일 월(${dto.month})/정책으로 진행 중인 실행이 있습니다 (ID: ${duplicateInTx.id})`);
      }

      const run = await tx.scoreRun.create({
        data: {
          siteId, policyVersionId: dto.policyVersionId, month: dto.month,
          status: policyVersion.status === 'SHADOW' ? 'SHADOW' : 'RUNNING',
          totalWorkers: workerMap.size,
        },
      });

      const entries: WorkerScoreData[] = [];
      for (const [workerId, stats] of workerMap.entries()) {
        // jobTrack이 해당 트랙과 다른 작업자는 제외 (신+구 트랙 호환)
        if (eligibleWorkerIds.size > 0 && !eligibleWorkerIds.has(workerId)) {
          continue;
        }
        if (stats.daysWorked.size < cfg.minDaysWorked && track !== 'MANAGER') {
          await tx.scoreEntry.create({
            data: {
              scoreRunId: run.id, workerId, track: policyVersion.track,
              performanceScore: 0, reliabilityScore: 0, teamworkScore: 0, totalScore: 0,
              details: JSON.stringify({ track, excluded: true, reason: `근무일수 부족 (${stats.daysWorked.size}/${cfg.minDaysWorked}일)` }),
            },
          });
          continue;
        }

        const scored = this.calculateScore(track, stats, weights, policyDetails, payoutBands);
        entries.push({ workerId, ...scored });
        await tx.scoreEntry.create({
          data: {
            scoreRunId: run.id, workerId, track: policyVersion.track,
            performanceScore: scored.performanceScore, reliabilityScore: scored.reliabilityScore,
            teamworkScore: scored.teamworkScore, totalScore: scored.totalScore,
            rank: null, // v3: 순위 비사용 (절대평가)
            details: JSON.stringify(scored.explanationJson),
          },
        });
      }

      // 참고용 순위만 부여 (지급에 영향 없음)
      const sorted = [...entries].sort((a, b) => b.totalScore - a.totalScore);
      for (let i = 0; i < sorted.length; i++) {
        await tx.scoreEntry.updateMany({
          where: { scoreRunId: run.id, workerId: sorted[i].workerId },
          data: { rank: i + 1 },
        });
      }

      return run;
    }, {
      // Serializable: 동시 요청 시 한 쪽 트랜잭션이 먼저 커밋되고 나머지는 재검증에서 차단됨
      isolationLevel: 'Serializable',
      maxWait: 5000,
      timeout: 30000,
    });

    this.logger.log(`ScoreRun created: ${scoreRun.id} (${dto.month}, ${track}, ${workerMap.size} workers)`);
    return this.getScoreRun(scoreRun.id);
  }

  // ════════════════════════════════════════════════════════════════
  // 4트랙 점수 산출 — 절대평가
  // ════════════════════════════════════════════════════════════════

  private calculateScore(
    track: string, stats: WorkerStats, weights: Weights,
    baselines: Baselines, payoutBands: typeof DEFAULT_PAYOUT_BANDS,
  ): Omit<WorkerScoreData, 'workerId'> {
    switch (track) {
      case 'OUTBOUND': return this.scoreOutbound(stats, weights, baselines, payoutBands);
      case 'INBOUND_DOCK': return this.scoreInboundDock(stats, weights, baselines, payoutBands);
      case 'INSPECTION': return this.scoreInspection(stats, weights, baselines, payoutBands);
      case 'MANAGER': return this.scoreManager(stats, weights, baselines, payoutBands);
      default: return this.scoreOutbound(stats, weights, baselines, payoutBands); // fallback
    }
  }

  // ── OUTBOUND (출고 전담) ── 절대평가 55/30/15 ─────────────────
  private scoreOutbound(
    stats: WorkerStats, weights: Weights, baselines: Baselines,
    payoutBands: typeof DEFAULT_PAYOUT_BANDS,
  ): Omit<WorkerScoreData, 'workerId'> {
    const bl = (baselines as any).outbound || BASELINES.outbound;
    const tpd = bl.throughputPerDay || BASELINES.outbound.throughputPerDay;
    const vpm = bl.volumePerMonth || BASELINES.outbound.volumePerMonth;

    // ── 성과 (0~100) ──
    // 처리량: 일평균 건수 vs 기준 (40점)
    const throughput = safeDiv(stats.completedCount, stats.daysWorked.size);
    const throughputScore = fix2(clamp(safeDiv(throughput, tpd), 0, 2) * 20); // 0-40

    // 효율성: CBM/시간 (30점)
    const eff = safeDiv(stats.totalVolume, stats.totalHoursWorked);
    const avgEffBaseline = safeDiv(vpm, (baselines as any).__workingDays || WORKING_DAYS); // 월기준 일평균 CBM
    const effScore = fix2(clamp(safeDiv(eff, avgEffBaseline), 0, 2) * 15); // 0-30

    // 물동량: 총 CBM (30점)
    const volScore = fix2(clamp(safeDiv(stats.totalVolume, vpm), 0, 2) * 15); // 0-30

    const performanceScore = fix2(clamp(throughputScore + effScore + volScore, 0, 100));

    // ── 신뢰도 (0~100) ──
    const attendScore = fix2(clamp(safeDiv(stats.daysWorked.size, (baselines as any).__workingDays || WORKING_DAYS) * 50, 0, 50));
    const voidRate = safeDiv(stats.voidCount, stats.totalCount);
    const editRate = safeDiv(stats.editCount, stats.totalCount);
    const voidPen = fix2(clamp(voidRate * 250, 0, 25));
    const editPen = fix2(clamp(editRate * 150, 0, 15));
    const reliabilityScore = fix2(clamp(attendScore - voidPen - editPen, 0, 100));

    // ── 팀워크 (0~100) ──
    const collabRate = safeDiv(stats.teamworkCount, stats.totalCount);
    const collabScore = fix2(clamp(collabRate * 50, 0, 50));
    const multiRate = safeDiv(stats.multiAssignmentCount, stats.totalCount);
    const multiScore = fix2(clamp(multiRate * 60, 0, 30));
    const helpScore = fix2(clamp(stats.coworkerCount * 0.5, 0, 20));
    const teamworkScore = fix2(clamp(collabScore + multiScore + helpScore, 0, 100));

    const totalScore = fix2(performanceScore * weights.performance / 100 + reliabilityScore * weights.reliability / 100 + teamworkScore * weights.teamwork / 100);
    const { grade, amount } = getGrade(totalScore, payoutBands);

    return {
      performanceScore, reliabilityScore, teamworkScore, totalScore, grade, estimatedPayout: amount,
      explanationJson: {
        track: 'OUTBOUND',
        performance: { total: performanceScore, throughput: { perDay: fix2(throughput), baseline: tpd, score: throughputScore }, efficiency: { cbmPerHour: fix2(eff), score: effScore }, volume: { total: fix2(stats.totalVolume), baseline: vpm, score: volScore } },
        reliability: { total: reliabilityScore, attendance: { days: stats.daysWorked.size, score: attendScore }, voidRate: { value: fix2(voidRate * 100), penalty: -voidPen }, editRate: { value: fix2(editRate * 100), penalty: -editPen } },
        teamwork: { total: teamworkScore, collaboration: collabScore, multiAssignment: multiScore, crossHelp: helpScore },
      },
    };
  }

  // ── INBOUND_DOCK (입고+상하차 통합) ── 55/30/15 ──────────────
  // 입고(InboundSession) + 출고 참여(WorkItem) 양방향 반영
  private scoreInboundDock(
    stats: WorkerStats, weights: Weights, baselines: Baselines,
    payoutBands: typeof DEFAULT_PAYOUT_BANDS,
  ): Omit<WorkerScoreData, 'workerId'> {
    const bl = (baselines as any).inbound_dock || BASELINES.inbound_dock;
    const sessBase = bl.sessionBaseline || BASELINES.inbound_dock.sessionBaseline;
    const qtyBase = bl.qtyBaseline || BASELINES.inbound_dock.qtyBaseline;
    const outVolBase = bl.outboundVolumeBaseline || BASELINES.inbound_dock.outboundVolumeBaseline;

    // ── 성과 ──
    // 입고 세션 수 (25점)
    const sessScore = fix2(clamp(safeDiv(stats.inboundSessionCount, sessBase), 0, 2) * 12.5);
    // 입고 수량 (25점)
    const qtyScore = fix2(clamp(safeDiv(stats.inboundApprovedQuantity, qtyBase), 0, 2) * 12.5);
    // 출고 참여 CBM — 상차 반영 (25점)
    const outScore = fix2(clamp(safeDiv(stats.totalVolume, outVolBase), 0, 2) * 12.5);
    // 정확도 (25점)
    const diffRate = safeDiv(stats.inboundDiffQuantity, stats.inboundApprovedQuantity);
    const accScore = fix2(clamp((1 - diffRate) * 25, 0, 25));
    const performanceScore = fix2(clamp(sessScore + qtyScore + outScore + accScore, 0, 100));

    // ── 신뢰도 ──
    const attendScore = fix2(clamp(safeDiv(stats.daysWorked.size, (baselines as any).__workingDays || WORKING_DAYS) * 50, 0, 50));
    const voidRate = safeDiv(stats.voidCount, stats.totalCount);
    const editRate = safeDiv(stats.editCount, stats.totalCount);
    const voidPen = fix2(clamp(voidRate * 200, 0, 25));
    const editPen = fix2(clamp(editRate * 100, 0, 15));
    const reliabilityScore = fix2(clamp(attendScore - voidPen - editPen, 0, 100));

    // ── 팀워크 ──
    const sessionTeam = fix2(clamp(stats.teamworkCount * 2, 0, 60));
    const crossWork = fix2(clamp((stats.inboundSessionCount > 0 && stats.totalVolume > 0 ? 40 : 0), 0, 40)); // 양방향 보너스
    const teamworkScore = fix2(clamp(sessionTeam + crossWork, 0, 100));

    const totalScore = fix2(performanceScore * weights.performance / 100 + reliabilityScore * weights.reliability / 100 + teamworkScore * weights.teamwork / 100);
    const { grade, amount } = getGrade(totalScore, payoutBands);

    return {
      performanceScore, reliabilityScore, teamworkScore, totalScore, grade, estimatedPayout: amount,
      explanationJson: {
        track: 'INBOUND_DOCK',
        performance: { total: performanceScore, inboundSessions: { value: stats.inboundSessionCount, baseline: sessBase, score: sessScore }, inboundQuantity: { value: stats.inboundApprovedQuantity, baseline: qtyBase, score: qtyScore }, outboundVolume: { cbm: fix2(stats.totalVolume), baseline: outVolBase, score: outScore }, accuracy: { diffRate: fix2(diffRate * 100), score: accScore } },
        reliability: { total: reliabilityScore, attendance: { days: stats.daysWorked.size, score: attendScore }, voidRate: { value: fix2(voidRate * 100), penalty: -voidPen }, editRate: { value: fix2(editRate * 100), penalty: -editPen } },
        teamwork: { total: teamworkScore, sessionTeamwork: sessionTeam, bidirectionalBonus: crossWork },
      },
    };
  }

  // ── INSPECTION (검수 전담) ── 55/30/15 ────────────────────────
  private scoreInspection(
    stats: WorkerStats, weights: Weights, baselines: Baselines,
    payoutBands: typeof DEFAULT_PAYOUT_BANDS,
  ): Omit<WorkerScoreData, 'workerId'> {
    const bl = (baselines as any).inspection || BASELINES.inspection;
    const inspBase = bl.baseline || BASELINES.inspection.baseline;
    const covBase = bl.coverageBaseline || BASELINES.inspection.coverageBaseline;
    const targetDef = bl.targetDefectRate || BASELINES.inspection.targetDefectRate;

    // ── 성과 ──
    const throughputScore = fix2(clamp(safeDiv(stats.inspectionsConducted, inspBase), 0, 2) * 17.5); // 0-35
    // 불량 탐지율 (목표 근접 = 최고점)
    const defectRate = safeDiv(stats.inspectionDefects, stats.inspectionQuantity);
    let detectionScore: number;
    if (stats.inspectionQuantity === 0) { detectionScore = 0; }
    else if (defectRate <= 0.001) { detectionScore = 10; } // 고무도장 의심
    else if (defectRate <= targetDef * 2) {
      const proximity = 1 - Math.abs(defectRate - targetDef) / (targetDef || 0.03);
      detectionScore = 30 + clamp(proximity * 10, 0, 10);
    } else if (defectRate <= 0.15) {
      const decay = 1 - safeDiv(defectRate - targetDef * 2, 0.15 - targetDef * 2);
      detectionScore = 15 + clamp(decay * 15, 0, 15);
    } else { detectionScore = 10; }
    detectionScore = fix2(detectionScore);
    const coverageScore = fix2(clamp(safeDiv(stats.inspectionQuantity, covBase), 0, 2) * 12.5); // 0-25
    const performanceScore = fix2(clamp(throughputScore + detectionScore + coverageScore, 0, 100));

    // ── 신뢰도 ──
    const attendScore = fix2(clamp(safeDiv(stats.daysWorked.size, (baselines as any).__workingDays || WORKING_DAYS) * 60, 0, 60));
    const voidRate = safeDiv(stats.voidCount, stats.totalCount);
    const editRate = safeDiv(stats.editCount, stats.totalCount);
    const voidPen = fix2(clamp(voidRate * 200, 0, 20));
    const editPen = fix2(clamp(editRate * 100, 0, 10));
    const reliabilityScore = fix2(clamp(attendScore - voidPen - editPen, 0, 100));

    // ── 팀워크 ──
    const supportScore = fix2(clamp(stats.teamworkCount * 2, 0, 60));
    const teamworkScore = fix2(clamp(supportScore, 0, 100));

    const totalScore = fix2(performanceScore * weights.performance / 100 + reliabilityScore * weights.reliability / 100 + teamworkScore * weights.teamwork / 100);
    const { grade, amount } = getGrade(totalScore, payoutBands);

    return {
      performanceScore, reliabilityScore, teamworkScore, totalScore, grade, estimatedPayout: amount,
      explanationJson: {
        track: 'INSPECTION',
        performance: { total: performanceScore, throughput: { value: stats.inspectionsConducted, baseline: inspBase, score: throughputScore }, detectionRate: { defectRate: fix2(defectRate * 100), targetRate: fix2(targetDef * 100), score: detectionScore }, coverage: { quantity: stats.inspectionQuantity, baseline: covBase, score: coverageScore } },
        reliability: { total: reliabilityScore, attendance: { days: stats.daysWorked.size, score: attendScore }, voidRate: { value: fix2(voidRate * 100), penalty: -voidPen }, editRate: { value: fix2(editRate * 100), penalty: -editPen } },
        teamwork: { total: teamworkScore, supportContribution: stats.teamworkCount },
      },
    };
  }

  // ── MANAGER (현장관리자) ── 40/35/25 ──────────────────────────
  private scoreManager(
    stats: WorkerStats, weights: Weights, baselines: Baselines,
    payoutBands: typeof DEFAULT_PAYOUT_BANDS,
  ): Omit<WorkerScoreData, 'workerId'> {
    const bl = (baselines as any).manager || BASELINES.manager;
    const teamBase = bl.teamScoreBaseline || BASELINES.manager.teamScoreBaseline;
    const excBase = bl.exceptionBaseline || BASELINES.manager.exceptionBaseline;

    const teamOutputScore = fix2(clamp(safeDiv(stats.managedWorkerAvgScore, teamBase) * 35, 0, 35));
    const exceptionScore = fix2(clamp(safeDiv(stats.exceptionsHandled, excBase), 0, 2) * 17.5);
    const coverageScore = fix2(clamp(safeDiv(stats.daysWorked.size, (baselines as any).__workingDays || WORKING_DAYS) * 30, 0, 30));
    const performanceScore = fix2(clamp(teamOutputScore + exceptionScore + coverageScore, 0, 100));

    const teamVoidRate = safeDiv(stats.teamTotalVoids, stats.teamTotalItems);
    const teamQuality = fix2(clamp((1 - teamVoidRate * 10) * 50, 0, 50));
    const attendScore = fix2(clamp(safeDiv(stats.daysWorked.size, (baselines as any).__workingDays || WORKING_DAYS) * 25, 0, 25));
    const reliabilityScore = fix2(clamp(teamQuality + attendScore + 25, 0, 100)); // +25 일관성 기본점

    const activityScore = fix2(clamp(stats.exceptionsHandled * 3, 0, 60));
    const crossScore = fix2(clamp(stats.teamworkCount * 4, 0, 40));
    const teamworkScore = fix2(clamp(activityScore + crossScore, 0, 100));

    const totalScore = fix2(performanceScore * weights.performance / 100 + reliabilityScore * weights.reliability / 100 + teamworkScore * weights.teamwork / 100);
    const { grade, amount } = getGrade(totalScore, payoutBands);

    return {
      performanceScore, reliabilityScore, teamworkScore, totalScore, grade, estimatedPayout: amount,
      explanationJson: {
        track: 'MANAGER',
        performance: { total: performanceScore, teamOutput: { avgScore: fix2(stats.managedWorkerAvgScore), baseline: teamBase, score: teamOutputScore }, exceptions: { count: stats.exceptionsHandled, baseline: excBase, score: exceptionScore }, coverage: { days: stats.daysWorked.size, score: coverageScore } },
        reliability: { total: reliabilityScore, teamQuality: { voidRate: fix2(teamVoidRate * 100), score: teamQuality }, attendance: { days: stats.daysWorked.size, score: attendScore } },
        teamwork: { total: teamworkScore, managementActivity: activityScore, crossSupport: crossScore },
      },
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 4트랙 전체 일괄 실행
  // ════════════════════════════════════════════════════════════════

  /**
   * 해당 사이트의 ACTIVE/SHADOW 상태 정책 전체를 순차로 실행한다.
   * - 각 정책별로 createScoreRun 호출
   * - 실패한 트랙은 결과에 포함하되 전체 실행은 계속
   */
  async runAllTracks(siteId: string, month: string) {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException('month는 YYYY-MM 형식이어야 합니다');
    }

    const policies = await this.prisma.policyVersion.findMany({
      where: {
        siteId,
        status: { in: ['ACTIVE', 'SHADOW'] },
        track: { in: [...VALID_TRACKS] as string[] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 트랙별로 가장 최신 정책 1개씩만 (동일 트랙 중복 시 제일 최근 것)
    const seen = new Set<string>();
    const latestByTrack: typeof policies = [];
    for (const p of policies) {
      const t = resolveTrack(p.track);
      if (!seen.has(t)) {
        seen.add(t);
        latestByTrack.push(p);
      }
    }

    const results: Array<{ track: string; status: 'success' | 'failed'; runId?: string; error?: string }> = [];
    for (const policy of latestByTrack) {
      try {
        const run = await this.createScoreRun(siteId, { policyVersionId: policy.id, month });
        results.push({ track: resolveTrack(policy.track), status: 'success', runId: (run as any)?.id });
      } catch (e: any) {
        results.push({ track: resolveTrack(policy.track), status: 'failed', error: e?.message || String(e) });
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    return {
      message: `${month} 전체 트랙 실행 완료 — 성공 ${successCount}/${results.length}트랙`,
      month,
      results,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // Score Run CRUD & Lifecycle
  // ════════════════════════════════════════════════════════════════

  async getScoreRuns(siteId: string | undefined, params: QueryScoreRunDto) {
    const page = params.page || 1; const limit = params.limit || 20; const skip = (page - 1) * limit;
    const where: Prisma.ScoreRunWhereInput = {};
    if (siteId) where.siteId = siteId;
    if (params.month) where.month = params.month;
    const [data, total] = await Promise.all([
      this.prisma.scoreRun.findMany({ where, include: { policyVersion: { select: { id: true, name: true, track: true } }, _count: { select: { entries: true } } }, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.scoreRun.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id },
      include: { policyVersion: { select: { id: true, name: true, track: true, weights: true } }, entries: { include: { worker: { select: { id: true, name: true, employeeCode: true } } }, orderBy: { totalScore: 'desc' } } },
    });
    if (!run) throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    return { ...run, entries: run.entries.map((e) => ({ ...e, performanceScore: Number(e.performanceScore), reliabilityScore: Number(e.reliabilityScore), teamworkScore: Number(e.teamworkScore), totalScore: Number(e.totalScore) })) };
  }

  async getScoreEntries(runId: string) {
    const entries = await this.prisma.scoreEntry.findMany({ where: { scoreRunId: runId }, include: { worker: { select: { id: true, name: true, employeeCode: true } } }, orderBy: { totalScore: 'desc' } });
    return entries.map((e) => ({ ...e, performanceScore: Number(e.performanceScore), reliabilityScore: Number(e.reliabilityScore), teamworkScore: Number(e.teamworkScore), totalScore: Number(e.totalScore) }));
  }

  async freezeScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    if (!['RUNNING', 'SHADOW'].includes(run.status)) throw new BadRequestException('RUNNING 또는 SHADOW 상태만 동결 가능합니다');
    await this.prisma.scoreRun.update({ where: { id }, data: { status: 'FROZEN', frozenAt: new Date() } });
    return this.getScoreRun(id);
  }

  async finalizeScoreRun(id: string) {
    const run = await this.prisma.scoreRun.findUnique({ where: { id }, include: { entries: { select: { id: true } } } });
    if (!run) throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    if (run.status !== 'FROZEN') throw new BadRequestException('동결 상태만 확정 가능합니다');
    const entryIds = run.entries.map((e) => e.id);
    if (entryIds.length > 0) {
      const open = await this.prisma.objectionCase.count({ where: { scoreEntryId: { in: entryIds }, status: { in: ['OPEN', 'REVIEWING'] } } });
      if (open > 0) throw new BadRequestException(`미처리 이의신청 ${open}건이 있습니다`);
    }
    await this.prisma.scoreRun.update({ where: { id }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
    return this.getScoreRun(id);
  }

  async recalculateAfterObjection(scoreRunId: string) {
    const run = await this.prisma.scoreRun.findUnique({ where: { id: scoreRunId }, include: { policyVersion: true, entries: { select: { id: true } } } });
    if (!run) throw new NotFoundException('점수 실행을 찾을 수 없습니다');
    const entryIds = run.entries.map((e) => e.id);
    let accepted = 0;
    if (entryIds.length > 0) accepted = await this.prisma.objectionCase.count({ where: { scoreEntryId: { in: entryIds }, status: 'ACCEPTED' } });
    if (accepted === 0) throw new BadRequestException('수락된 이의신청이 없습니다');
    await this.prisma.scoreRun.update({ where: { id: scoreRunId }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
    return this.createScoreRun(run.siteId, { policyVersionId: run.policyVersionId, month: run.month });
  }

  // ════════════════════════════════════════════════════════════════
  // Objections
  // ════════════════════════════════════════════════════════════════

  async getObjections(siteId: string | undefined, params: QueryObjectionDto) {
    const page = params.page || 1; const limit = params.limit || 20; const skip = (page - 1) * limit;
    const where: Prisma.ObjectionCaseWhereInput = {};
    if (siteId) where.siteId = siteId;
    if (params.status) where.status = params.status;
    const [data, total] = await Promise.all([
      this.prisma.objectionCase.findMany({ where, include: { worker: { select: { id: true, name: true, employeeCode: true } } }, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.objectionCase.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createObjection(dto: CreateObjectionDto, siteId: string, workerId: string) {
    if (dto.scoreEntryId) {
      const entry = await this.prisma.scoreEntry.findUnique({ where: { id: dto.scoreEntryId } });
      if (!entry) throw new NotFoundException('점수 항목을 찾을 수 없습니다');
    }
    const obj = await this.prisma.objectionCase.create({
      data: { scoreEntryId: dto.scoreEntryId, workerId, siteId, month: dto.month, reason: dto.reason, status: 'OPEN' },
      include: { worker: { select: { id: true, name: true, employeeCode: true } } },
    });
    return obj;
  }

  async resolveObjection(id: string, resolution: string, resolvedBy: string) {
    const obj = await this.prisma.objectionCase.findUnique({ where: { id } });
    if (!obj) throw new NotFoundException('이의신청을 찾을 수 없습니다');
    if (!['OPEN', 'REVIEWING'].includes(obj.status)) throw new BadRequestException('OPEN 또는 REVIEWING만 처리 가능');
    const isAccepted = resolution.toLowerCase().startsWith('accept');
    return this.prisma.objectionCase.update({
      where: { id },
      data: { status: isAccepted ? 'ACCEPTED' : 'REJECTED', resolution, resolvedBy, resolvedAt: new Date() },
      include: { worker: { select: { id: true, name: true, employeeCode: true } } },
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Policy Pack Templates
  // ════════════════════════════════════════════════════════════════

  async getPolicyPackTemplates() {
    const templates = await this.prisma.policyPackTemplate.findMany({ orderBy: { createdAt: 'asc' } });
    return { data: templates.map((t) => ({ ...t, tracks: typeof t.tracks === 'string' ? JSON.parse(t.tracks) : t.tracks })) };
  }

  async applyPolicyPack(templateId: string, siteId: string) {
    const template = await this.prisma.policyPackTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException('정책 팩을 찾을 수 없습니다');
    const configs = typeof template.tracks === 'string' ? JSON.parse(template.tracks) : template.tracks;
    if (!Array.isArray(configs) || configs.length === 0) throw new BadRequestException('정책 팩에 트랙 설정이 없습니다');
    await this.prisma.policyVersion.updateMany({ where: { siteId, status: { in: ['ACTIVE', 'SHADOW'] } }, data: { status: 'RETIRED', effectiveTo: new Date() } });
    const created: unknown[] = [];
    for (const cfg of configs) {
      const pv = await this.prisma.policyVersion.create({
        data: { siteId, name: `[${template.name}] ${cfg.name || cfg.track}`, description: `정책 팩 자동 생성`, track: cfg.track, weights: JSON.stringify(cfg.weights), status: 'SHADOW', effectiveFrom: new Date() },
      });
      created.push(pv);
    }
    return { message: `${created.length}개 트랙 정책이 SHADOW로 생성되었습니다`, policies: created };
  }

  // ════════════════════════════════════════════════════════════════
  // Payout — 등급형 지급
  // ════════════════════════════════════════════════════════════════

  async generatePayoutDryRun(scoreRunId: string, baseIncentive: number = 500000) {
    const run = await this.prisma.scoreRun.findUnique({
      where: { id: scoreRunId },
      include: { policyVersion: { select: { id: true, name: true, track: true, weights: true, details: true } }, entries: { include: { worker: { select: { id: true, name: true, employeeCode: true } } }, orderBy: { totalScore: 'desc' } } },
    });
    if (!run) throw new NotFoundException('점수 실행을 찾을 수 없습니다');

    let payoutBands = DEFAULT_PAYOUT_BANDS;
    if (run.policyVersion?.details) {
      try { const d = JSON.parse(run.policyVersion.details); if (d.payoutBands) payoutBands = d.payoutBands; } catch { /* ignore */ }
    }

    // baseIncentive로 밴드 금액 비례 스케일링 (기본값 500000 = A등급 기준)
    const aAmount = payoutBands.find((b: any) => b.grade === 'A')?.amount || 500000;
    const scale = aAmount > 0 ? baseIncentive / aAmount : 1;
    const effectiveBands = scale !== 1
      ? payoutBands.map((b: any) => ({ ...b, amount: Math.round(b.amount * scale) }))
      : payoutBands;

    const payoutData = run.entries.map((entry) => {
      const totalScore = Number(entry.totalScore) || 0;
      const { grade, amount } = getGrade(totalScore, effectiveBands);
      return {
        workerId: entry.worker.id, workerName: entry.worker.name, employeeCode: entry.worker.employeeCode,
        track: entry.track,
        performanceScore: Number(entry.performanceScore) || 0,
        reliabilityScore: Number(entry.reliabilityScore) || 0,
        teamworkScore: Number(entry.teamworkScore) || 0,
        totalScore, rank: entry.rank, grade, estimatedPayout: amount,
      };
    });

    return {
      scoreRunId: run.id, month: run.month, status: run.status,
      policyName: run.policyVersion?.name || '-', track: run.policyVersion?.track || '-',
      baseIncentive, payoutBands: effectiveBands,
      totalPayout: payoutData.reduce((s, p) => s + p.estimatedPayout, 0),
      workerCount: payoutData.length, data: payoutData,
      gradeDistribution: {
        A: payoutData.filter((p) => p.grade === 'A').length,
        B: payoutData.filter((p) => p.grade === 'B').length,
        C: payoutData.filter((p) => p.grade === 'C').length,
        D: payoutData.filter((p) => p.grade === 'D').length,
        E: payoutData.filter((p) => p.grade === 'E').length,
      },
    };
  }
}
