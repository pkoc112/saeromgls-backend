import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface AnomalyAlert {
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  workerId?: string;
  workerName?: string;
  details: string;
  detectedAt: string;
}

export interface WorkloadForecast {
  date: string;
  predictedCount: number;
  predictedVolume: number;
  predictedQuantity: number;
  confidence: number;
  historicalData?: {
    date: string;
    count: number;
    volume: number;
    quantity: number;
  }[];
}

@Injectable()
export class MlGovernanceService {
  private readonly logger = new Logger(MlGovernanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ======================== Difficulty Approvals ========================

  /**
   * AI 난이도 추천 승인 — baseline_snapshot 생성
   */
  async approveDifficulty(predictionLogId: string, approvedBy: string) {
    const log = await this.prisma.predictionLog.findUnique({
      where: { id: predictionLogId },
    });

    if (!log) {
      throw new NotFoundException('예측 로그를 찾을 수 없습니다');
    }

    if (log.approvalStatus !== 'PENDING') {
      throw new BadRequestException('이미 처리된 예측입니다');
    }

    // 승인 처리
    const updated = await this.prisma.predictionLog.update({
      where: { id: predictionLogId },
      data: {
        approvalStatus: 'APPROVED',
        approvedBy,
        approvedAt: new Date(),
      },
    });

    // baseline_snapshot 생성 (월 정보 추출)
    const month = updated.createdAt.toISOString().slice(0, 7); // "2026-04"
    await this.prisma.baselineSnapshot.upsert({
      where: {
        siteId_month_type: {
          siteId: updated.siteId,
          month,
          type: 'DIFFICULTY',
        },
      },
      create: {
        siteId: updated.siteId,
        month,
        type: 'DIFFICULTY',
        data: updated.output,
        approvedBy,
      },
      update: {
        data: updated.output,
        approvedBy,
      },
    });

    this.logger.log(`난이도 분석 승인: ${predictionLogId} by ${approvedBy}`);
    return updated;
  }

  /**
   * AI 난이도 추천 거절
   */
  async rejectDifficulty(predictionLogId: string, reason: string, rejectedBy: string) {
    const log = await this.prisma.predictionLog.findUnique({
      where: { id: predictionLogId },
    });

    if (!log) {
      throw new NotFoundException('예측 로그를 찾을 수 없습니다');
    }

    if (log.approvalStatus !== 'PENDING') {
      throw new BadRequestException('이미 처리된 예측입니다');
    }

    const updated = await this.prisma.predictionLog.update({
      where: { id: predictionLogId },
      data: {
        approvalStatus: 'REJECTED',
        approvedBy: rejectedBy,
        approvedAt: new Date(),
        // 거절 사유를 output JSON에 추가
        output: JSON.stringify({
          ...(this.safeParseJson(log.output) || { original: log.output }),
          rejectionReason: reason,
        }),
      },
    });

    this.logger.log(`난이도 분석 거절: ${predictionLogId} by ${rejectedBy}, 사유: ${reason}`);
    return updated;
  }

  /**
   * 난이도 승인 목록 조회
   */
  async getDifficultyApprovals(
    siteId: string | undefined,
    options: { month?: string; status?: string },
  ) {
    const where: Prisma.PredictionLogWhereInput = {
      predictionType: 'DIFFICULTY',
    };

    if (siteId) {
      where.OR = [{ siteId }, { siteId: '' }];
    }
    if (options.status) {
      where.approvalStatus = options.status;
    }
    if (options.month) {
      // 해당 월의 시작~끝 범위
      const start = new Date(`${options.month}-01T00:00:00Z`);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      where.createdAt = { gte: start, lt: end };
    }

    const data = await this.prisma.predictionLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        site: { select: { name: true, code: true } },
      },
    });

    return { data, total: data.length };
  }

  // ======================== Anomaly Detection ========================

  /**
   * 규칙 기반 이상 탐지
   */
  async detectAnomalies(
    siteId: string | undefined,
    from: string,
    to: string,
  ): Promise<{ anomalies: AnomalyAlert[]; summary: { total: number; high: number; medium: number; low: number } }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const workerWhere: Prisma.WorkerWhereInput | undefined = siteId
      ? { OR: [{ siteId }, { siteId: null }] }
      : undefined;

    const anomalies: AnomalyAlert[] = [];

    // Rule 1: VOID rate > 10%
    const [totalCount, voidCount] = await Promise.all([
      this.prisma.workItem.count({
        where: {
          startedAt: { gte: fromDate, lte: toDate },
          ...(workerWhere ? { startedByWorker: workerWhere } : {}),
        },
      }),
      this.prisma.workItem.count({
        where: {
          startedAt: { gte: fromDate, lte: toDate },
          status: 'VOID',
          ...(workerWhere ? { startedByWorker: workerWhere } : {}),
        },
      }),
    ]);

    if (totalCount > 0) {
      const voidRate = (voidCount / totalCount) * 100;
      if (voidRate > 10) {
        anomalies.push({
          type: 'HIGH_VOID_RATE',
          severity: 'HIGH',
          details: `무효화 비율이 ${voidRate.toFixed(1)}%입니다 (${voidCount}/${totalCount}건). 기준: 10% 초과`,
          detectedAt: new Date().toISOString(),
        });
      }
    }

    // Rule 2: Admin edits > 5/day
    const auditLogs = await this.prisma.auditLog.findMany({
      where: {
        createdAt: { gte: fromDate, lte: toDate },
        action: { in: ['UPDATE', 'EDIT', 'VOID', 'ADMIN_EDIT'] },
      },
      select: {
        createdAt: true,
        actorWorker: { select: { employeeCode: true, name: true } },
      },
    });

    // 일별 그룹핑
    const editsByDay: Record<string, { count: number; actors: Set<string> }> = {};
    for (const log of auditLogs) {
      const day = log.createdAt.toISOString().slice(0, 10);
      if (!editsByDay[day]) editsByDay[day] = { count: 0, actors: new Set() };
      editsByDay[day].count++;
      editsByDay[day].actors.add(log.actorWorker.employeeCode);
    }

    for (const [day, data] of Object.entries(editsByDay)) {
      if (data.count > 5) {
        anomalies.push({
          type: 'EXCESSIVE_ADMIN_EDITS',
          severity: 'MEDIUM',
          details: `${day}에 관리자 수정이 ${data.count}건 발생했습니다 (기준: 5건/일 초과). 수정자: ${Array.from(data.actors).join(', ')}`,
          detectedAt: new Date().toISOString(),
        });
      }
    }

    // Rule 3: Late endings (>2 hours after average)
    const endedItems = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: fromDate, lte: toDate },
        status: 'ENDED',
        endedAt: { not: null },
        ...(workerWhere ? { startedByWorker: workerWhere } : {}),
      },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        startedByWorker: { select: { employeeCode: true, name: true } },
        classification: { select: { code: true } },
      },
    });

    if (endedItems.length > 0) {
      const durations = endedItems
        .filter((item) => item.endedAt)
        .map((item) => item.endedAt!.getTime() - item.startedAt.getTime());
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const threshold = avgDuration + 2 * 3600 * 1000; // avg + 2 hours

      for (const item of endedItems) {
        if (!item.endedAt) continue;
        const duration = item.endedAt.getTime() - item.startedAt.getTime();
        if (duration > threshold) {
          const durationMin = Math.round(duration / 60000);
          const avgMin = Math.round(avgDuration / 60000);
          anomalies.push({
            type: 'LATE_ENDING',
            severity: 'LOW',
            workerId: item.startedByWorker.employeeCode,
            workerName: item.startedByWorker.name,
            details: `작업 소요시간 ${durationMin}분 (평균 ${avgMin}분 대비 2시간 이상 초과). 분류: ${item.classification.code}`,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }

    // Rule 4: Missing participants (assignments with 0 participants for group work)
    const activeNoParticipants = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: fromDate, lte: toDate },
        status: { in: ['ACTIVE', 'ENDED'] },
        metricMode: 'GROUP',
        ...(workerWhere ? { startedByWorker: workerWhere } : {}),
      },
      select: {
        id: true,
        startedAt: true,
        startedByWorker: { select: { employeeCode: true, name: true } },
        classification: { select: { code: true } },
        _count: { select: { assignments: true } },
      },
    });

    for (const item of activeNoParticipants) {
      if (item._count.assignments === 0) {
        anomalies.push({
          type: 'MISSING_PARTICIPANTS',
          severity: 'MEDIUM',
          workerId: item.startedByWorker.employeeCode,
          workerName: item.startedByWorker.name,
          details: `그룹 작업에 참여자가 배정되지 않았습니다. 분류: ${item.classification.code}, 시작: ${item.startedAt.toISOString().slice(0, 16)}`,
          detectedAt: new Date().toISOString(),
        });
      }
    }

    // Summary
    const summary = {
      total: anomalies.length,
      high: anomalies.filter((a) => a.severity === 'HIGH').length,
      medium: anomalies.filter((a) => a.severity === 'MEDIUM').length,
      low: anomalies.filter((a) => a.severity === 'LOW').length,
    };

    return { anomalies, summary };
  }

  // ======================== Workload Forecast ========================

  /**
   * 간단한 작업량 예측 (동일 요일 최근 7주 평균)
   */
  async forecastWorkload(siteId: string | undefined, targetDate: string): Promise<WorkloadForecast> {
    const target = new Date(targetDate);
    const dayOfWeek = target.getDay(); // 0 = Sunday

    const workerWhere: Prisma.WorkerWhereInput | undefined = siteId
      ? { OR: [{ siteId }, { siteId: null }] }
      : undefined;

    // 최근 7주의 동일 요일 데이터
    const historicalData: { date: string; count: number; volume: number; quantity: number }[] = [];

    for (let week = 1; week <= 7; week++) {
      const d = new Date(target);
      d.setDate(d.getDate() - week * 7);
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setHours(23, 59, 59, 999);

      const items = await this.prisma.workItem.findMany({
        where: {
          startedAt: { gte: dayStart, lte: dayEnd },
          status: { not: 'VOID' },
          ...(workerWhere ? { startedByWorker: workerWhere } : {}),
        },
        select: {
          volume: true,
          quantity: true,
        },
      });

      if (items.length > 0) {
        historicalData.push({
          date: d.toISOString().slice(0, 10),
          count: items.length,
          volume: items.reduce((sum, item) => sum + Number(item.volume), 0),
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
        });
      }
    }

    if (historicalData.length === 0) {
      return {
        date: targetDate,
        predictedCount: 0,
        predictedVolume: 0,
        predictedQuantity: 0,
        confidence: 0,
        historicalData: [],
      };
    }

    // 평균 계산
    const avgCount = Math.round(
      historicalData.reduce((sum, d) => sum + d.count, 0) / historicalData.length,
    );
    const avgVolume = Math.round(
      (historicalData.reduce((sum, d) => sum + d.volume, 0) / historicalData.length) * 100,
    ) / 100;
    const avgQuantity = Math.round(
      historicalData.reduce((sum, d) => sum + d.quantity, 0) / historicalData.length,
    );

    // 신뢰도: 데이터가 많을수록, 분산이 작을수록 높음
    const countVariance =
      historicalData.length > 1
        ? historicalData.reduce((sum, d) => sum + Math.pow(d.count - avgCount, 2), 0) /
          historicalData.length
        : 0;
    const countStdDev = Math.sqrt(countVariance);
    const cv = avgCount > 0 ? countStdDev / avgCount : 1; // coefficient of variation
    // confidence: 0 ~ 1, 데이터 수와 CV 기반
    const dataFactor = Math.min(historicalData.length / 7, 1); // max 1 at 7 weeks
    const cvFactor = Math.max(0, 1 - cv); // lower CV = higher confidence
    const confidence = Math.round(dataFactor * cvFactor * 10000) / 10000;

    return {
      date: targetDate,
      predictedCount: avgCount,
      predictedVolume: avgVolume,
      predictedQuantity: avgQuantity,
      confidence,
      historicalData,
    };
  }

  // ======================== Prediction Logs ========================

  /**
   * 예측 로그 페이지네이션 조회
   */
  async getPredictionLogs(
    siteId: string | undefined,
    type: string | undefined,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.PredictionLogWhereInput = {};

    if (siteId) {
      where.OR = [{ siteId }, { siteId: '' }];
    }
    if (type) {
      where.predictionType = type;
    }

    const [data, total] = await Promise.all([
      this.prisma.predictionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          site: { select: { name: true, code: true } },
        },
      }),
      this.prisma.predictionLog.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ======================== Helpers ========================

  private safeParseJson(str: string): Record<string, unknown> | null {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }
}
