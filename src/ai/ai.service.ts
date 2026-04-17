import { Injectable, Logger, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { calcNetWorkMinutes } from '../common/utils/net-work-minutes';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Anthropic client initialized');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set - AI features disabled');
    }
  }

  /**
   * 주간 요약 생성
   * 지정 기간의 작업 데이터를 분석하여 요약 리포트 생성
   * PII 최소화: 작업자 이름 대신 사번 사용
   */
  async generateWeeklySummary(fromDate: string, toDate: string) {
    this.ensureClientReady();

    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);

    // 분석 데이터 수집 (PII 최소화 -- 이름 대신 사번 사용)
    const workItems = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: from, lte: to },
        status: { not: 'VOID' },
      },
      select: {
        status: true,
        volume: true,
        quantity: true,
        startedAt: true,
        endedAt: true,
        notes: true, // pauseHistory 파싱용
        classification: { select: { code: true } },
        startedByWorker: { select: { employeeCode: true } },
        assignments: {
          select: { worker: { select: { employeeCode: true } }, role: true },
        },
      },
    });

    if (workItems.length === 0) {
      return { message: '해당 기간에 작업 데이터가 없습니다', period: `${fromDate} ~ ${toDate}` };
    }

    // 통계 요약 데이터 준비
    const summary = this.buildStatsSummary(workItems);

    const prompt = `다음은 현장 작업 기록 시스템의 ${fromDate} ~ ${toDate} 기간 데이터 요약입니다.
이 데이터를 분석하여 한국어로 주간 요약 리포트를 작성해주세요.

데이터 요약:
${JSON.stringify(summary, null, 2)}

다음 항목을 포함해주세요:
1. 전체 개요 (총 작업 건수, 완료율, 총 물량)
2. 분류별 실적 분석
3. 작업자별 생산성 (상위/하위 작업자 사번으로 표시)
4. 평균 작업 시간 분석
5. 특이사항 및 개선 제안

형식은 마크다운으로 작성하되, 간결하게 핵심만 포함해주세요.`;

    const content = await this.callClaude(prompt);

    // 결과 저장
    const insight = await this.prisma.dashboardInsight.create({
      data: {
        type: 'WEEKLY_SUMMARY',
        period: `${fromDate} ~ ${toDate}`,
        content,
        generatedAt: new Date(),
      },
    });

    return insight;
  }

  /**
   * 이상 탐지
   * 지정 기간의 작업 데이터에서 비정상 패턴 감지
   */
  async detectAnomalies(fromDate: string, toDate: string) {
    this.ensureClientReady();

    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);

    const workItems = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        status: true,
        volume: true,
        quantity: true,
        startedAt: true,
        endedAt: true,
        notes: true, // pauseHistory 파싱용
        classification: { select: { code: true } },
        startedByWorker: { select: { employeeCode: true } },
      },
    });

    if (workItems.length === 0) {
      return { message: '해당 기간에 작업 데이터가 없습니다', anomalies: [] };
    }

    // 이상 탐지를 위한 데이터 준비 (중간마감 차감한 순수 작업시간 사용)
    const analysisData = workItems.map((item) => ({
      status: item.status,
      classification: item.classification.code,
      worker_code: item.startedByWorker.employeeCode,
      volume: Number(item.volume),
      quantity: item.quantity,
      started_at: item.startedAt.toISOString(),
      ended_at: item.endedAt?.toISOString() || null,
      duration_minutes: item.endedAt
        ? calcNetWorkMinutes(item.startedAt, item.endedAt, item.notes)
        : null,
    }));

    const prompt = `다음은 현장 작업 기록 시스템의 ${fromDate} ~ ${toDate} 기간 작업 데이터입니다.
이 데이터에서 이상 패턴을 탐지해주세요.

작업 데이터 (${analysisData.length}건):
${JSON.stringify(analysisData, null, 2)}

다음 유형의 이상을 확인해주세요:
1. 비정상적으로 긴/짧은 작업 시간 (평균 대비)
2. 비정상적으로 높은/낮은 물량
3. 무효화(VOID)된 작업 패턴
4. 특정 작업자의 반복적 이상 패턴
5. 미종료(ACTIVE) 상태가 장기간 유지된 작업
6. 동일 시간대 중복 작업 의심 건

한국어로 작성하되, 각 이상 항목에 대해:
- 이상 유형
- 해당 데이터 (작업자 사번, 시간 등)
- 심각도 (높음/중간/낮음)
- 권장 조치

형식은 마크다운으로 간결하게 작성해주세요.`;

    const content = await this.callClaude(prompt);

    // 결과 저장
    const insight = await this.prisma.dashboardInsight.create({
      data: {
        type: 'ANOMALY',
        period: `${fromDate} ~ ${toDate}`,
        content,
        generatedAt: new Date(),
      },
    });

    return insight;
  }

  /**
   * 생성된 인사이트 목록 조회
   */
  async getInsights(params: { type?: string; page?: number; limit?: number }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where = params.type ? { type: params.type } : {};

    const [data, total] = await Promise.all([
      this.prisma.dashboardInsight.findMany({
        where,
        orderBy: { generatedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.dashboardInsight.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * AI 기반 엔터프라이즈 정책 팩 생성
   * 실제 운영 데이터를 분석하여 최적 가중치를 추천
   */
  async generatePolicyPack(siteId: string) {
    this.ensureClientReady();

    // 중복 방지: 이미 DRAFT/SHADOW/ACTIVE 정책이 있으면 차단
    const existingPolicies = await this.prisma.policyVersion.count({
      where: { siteId, status: { in: ['DRAFT', 'SHADOW', 'ACTIVE'] } },
    });
    if (existingPolicies > 0) {
      throw new BadRequestException(
        `이미 ${existingPolicies}개의 활성 정책이 있습니다. 기존 정책을 RETIRED로 변경한 후 다시 생성해주세요.`,
      );
    }

    // 운영 데이터 수집
    const [workers, workItems, inspections, inboundSessions, dockSessions, voidCount, editCount] = await Promise.all([
      this.prisma.worker.findMany({
        where: { siteId, status: 'ACTIVE', role: { notIn: ['MASTER', 'ADMIN'] } },
        select: { id: true, name: true, employeeCode: true, jobTrack: true, role: true },
      }),
      this.prisma.workItem.findMany({
        where: { status: 'ENDED', startedByWorker: { OR: [{ siteId }, { siteId: null }] } },
        select: { id: true, volume: true, quantity: true, startedAt: true, endedAt: true, startedByWorkerId: true },
        orderBy: { startedAt: 'desc' },
        take: 500,
      }),
      this.prisma.inspectionRecord.count({ where: { siteId } }),
      this.prisma.inboundSession.count({ where: { siteId } }),
      this.prisma.dockSession.count({ where: { siteId } }),
      this.prisma.workItem.count({ where: { status: 'VOID', startedByWorker: { OR: [{ siteId }, { siteId: null }] } } }),
      this.prisma.auditLog.count({ where: { action: 'EDIT' } }),
    ]);

    // 직무 트랙 분포
    const trackDist: Record<string, number> = {};
    workers.forEach((w) => { trackDist[w.jobTrack || 'UNASSIGNED'] = (trackDist[w.jobTrack || 'UNASSIGNED'] || 0) + 1; });

    // 작업 통계
    const totalItems = workItems.length;
    const avgVolume = totalItems > 0
      ? Math.round(workItems.reduce((s, w) => s + Number(w.volume), 0) / totalItems * 100) / 100
      : 0;
    const avgQuantity = totalItems > 0
      ? Math.round(workItems.reduce((s, w) => s + w.quantity, 0) / totalItems)
      : 0;
    const voidRate = totalItems > 0 ? Math.round(voidCount / (totalItems + voidCount) * 1000) / 10 : 0;

    const dataContext = {
      siteWorkers: workers.length,
      trackDistribution: trackDist,
      totalWorkItems: totalItems,
      avgVolumePerItem: avgVolume,
      avgQuantityPerItem: avgQuantity,
      voidRate: `${voidRate}%`,
      editCount,
      inspectionRecords: inspections,
      inboundSessions: inboundSessions,
      dockSessions: dockSessions,
    };

    const prompt = `당신은 물류센터 인센티브 정책 설계 전문가입니다.

아래 운영 데이터를 분석하여 5개 직무 트랙별 최적 인센티브 정책을 설계해주세요.

## 운영 데이터
${JSON.stringify(dataContext, null, 2)}

## 5개 직무 트랙
1. OUTBOUND_RANKED (출고 전담) - 상대평가
2. INBOUND_SUPPORT (입고+출고 혼합) - 세션 기여형
3. INSPECTION_GOAL (검수 전담) - 절대평가
4. DOCK_WRAP_GOAL (상하차/랩핑 전담) - 절대평가
5. MANAGER_OPS (현장 관리자) - 별도 보너스

## 설계 원칙
- 총점 100점 = 직무성과 + 기록신뢰도 + 팀기여
- 직무성과: 40~70점 범위
- 기록신뢰도: 15~30점 범위
- 팀기여: 10~20점 범위
- 세 합계는 반드시 100
- 검수/상하차는 1명이므로 절대평가형
- 무효화율이 높으면 신뢰도 가중치 높이기
- 입고 세션이 있으면 입고 트랙 가중치 조정
- 관리자는 성과보다 운영 품질 중심

## 반드시 아래 JSON 형식으로만 응답 (마크다운 없이):
{
  "packName": "팩 이름",
  "description": "팩 설명 (1줄)",
  "rationale": "설계 근거 (3줄 이내)",
  "tracks": [
    {
      "track": "OUTBOUND_RANKED",
      "name": "출고 인센티브 정책",
      "performance": 60,
      "reliability": 25,
      "teamwork": 15,
      "details": "처리량25 + 효율20 + 난이도15"
    }
  ]
}`;

    const content = await this.callClaude(prompt);

    // JSON 파싱
    let packData: any;
    try {
      // 마크다운 코드블록 제거
      const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      packData = JSON.parse(cleaned);
    } catch {
      this.logger.error('AI 정책 팩 JSON 파싱 실패');
      throw new Error('AI 응답을 파싱할 수 없습니다');
    }

    // 정책 생성
    const created: any[] = [];
    for (const track of packData.tracks || []) {
      const weights = JSON.stringify({
        performance: track.performance,
        reliability: track.reliability,
        teamwork: track.teamwork,
      });

      const policy = await this.prisma.policyVersion.create({
        data: {
          siteId,
          name: track.name,
          description: `${packData.rationale || ''}\n세부: ${track.details || ''}`,
          track: track.track,
          weights,
          details: track.details || null,
          status: 'DRAFT',
        },
      });
      created.push(policy);
    }

    this.logger.log(`AI Policy Pack generated: ${packData.packName} (${created.length} policies)`);

    return {
      packName: packData.packName,
      description: packData.description,
      rationale: packData.rationale,
      policiesCreated: created.length,
      policies: created,
    };
  }

  /**
   * 납품처 난이도 분석
   * 한달치 작업 데이터를 기반으로 납품처별 난이도를 AI가 평가
   */
  async analyzeDifficulty(fromDate: string, toDate: string, siteId?: string) {
    this.ensureClientReady();

    const from = new Date(fromDate);
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);

    const where: Prisma.WorkItemWhereInput = {
      startedAt: { gte: from, lte: to },
      status: 'ENDED',
    };
    if (siteId) {
      where.startedByWorker = { OR: [{ siteId }, { siteId: null }] };
    }

    const workItems = await this.prisma.workItem.findMany({
      where,
      select: {
        volume: true,
        quantity: true,
        startedAt: true,
        endedAt: true,
        notes: true, // pauseHistory 파싱용
        classification: { select: { code: true, displayName: true } },
        startedByWorker: { select: { employeeCode: true } },
        assignments: {
          select: { worker: { select: { employeeCode: true } } },
        },
      },
    });

    if (workItems.length === 0) {
      return { message: '해당 기간에 완료된 작업 데이터가 없습니다', period: `${fromDate} ~ ${toDate}` };
    }

    // 납품처별 통계 집계
    const byDest: Record<string, {
      name: string;
      count: number;
      totalVolume: number;
      totalQuantity: number;
      durations: number[];
      workerSet: Set<string>;
    }> = {};

    for (const item of workItems) {
      const code = item.classification.code;
      const name = item.classification.displayName;
      if (!byDest[code]) {
        byDest[code] = { name, count: 0, totalVolume: 0, totalQuantity: 0, durations: [], workerSet: new Set() };
      }
      const d = byDest[code];
      d.count++;
      d.totalVolume += Number(item.volume);
      d.totalQuantity += item.quantity;
      if (item.endedAt) {
        // 순수 작업시간(중간마감 차감)
        d.durations.push(calcNetWorkMinutes(item.startedAt, item.endedAt, item.notes));
      }
      d.workerSet.add(item.startedByWorker.employeeCode);
      for (const a of item.assignments) {
        d.workerSet.add(a.worker.employeeCode);
      }
    }

    // Claude에 보낼 데이터 정리
    const destStats = Object.entries(byDest).map(([code, d]) => {
      const avgMin = d.durations.length > 0
        ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length)
        : 0;
      const stdDev = d.durations.length > 1
        ? Math.round(Math.sqrt(d.durations.reduce((sum, v) => sum + Math.pow(v - avgMin, 2), 0) / d.durations.length))
        : 0;
      const avgVolume = d.count > 0 ? Math.round((d.totalVolume / d.count) * 100) / 100 : 0;
      const minPerCbm = d.totalVolume > 0
        ? Math.round((d.durations.reduce((a, b) => a + b, 0) / d.totalVolume) * 10) / 10
        : 0;

      return {
        code,
        name: d.name,
        count: d.count,
        avgVolumeCbm: avgVolume,
        totalQuantityBox: d.totalQuantity,
        avgDurationMin: avgMin,
        stdDevMin: stdDev,
        minPerCbm,
        workerCount: d.workerSet.size,
      };
    }).sort((a, b) => b.count - a.count);

    const prompt = `당신은 물류센터 작업 데이터 분석 전문가입니다.
다음은 ${fromDate} ~ ${toDate} 기간의 납품처별 작업 통계입니다.

**총 ${workItems.length}건 완료 작업, ${destStats.length}개 납품처**

납품처별 통계:
${JSON.stringify(destStats, null, 2)}

각 필드 설명:
- count: 작업 건수
- avgVolumeCbm: 건당 평균 용적(CBM)
- totalQuantityBox: 총 수량(BOX)
- avgDurationMin: 평균 작업시간(분)
- stdDevMin: 작업시간 표준편차(분) — 높을수록 불안정
- minPerCbm: CBM당 소요시간(분) — 높을수록 효율 낮음
- workerCount: 투입 작업자 수

다음 분석을 수행해주세요:

## 1. 납품처 난이도 등급 (A~E)
각 납품처에 난이도 등급을 매기고 근거를 설명해주세요.
- A (매우 쉬움): 효율적, 시간 안정적
- B (쉬움): 평균 수준
- C (보통): 일부 어려움
- D (어려움): 시간 많이 걸림, 불안정
- E (매우 어려움): 고난이도

## 2. 효율성 분석
CBM당 소요시간 기준으로 가장 효율적인/비효율적인 납품처 Top 3

## 3. 인력 배치 제안
난이도 기반으로 어떤 납품처에 숙련자를 배치해야 하는지 제안

## 4. 운영 개선 포인트
데이터에서 발견된 개선 가능한 포인트

마크다운 형식으로 간결하게 작성해주세요. 표를 적극 활용해주세요.`;

    const content = await this.callClaude(prompt);

    const insight = await this.prisma.dashboardInsight.create({
      data: {
        type: 'DIFFICULTY_ANALYSIS',
        period: `${fromDate} ~ ${toDate}`,
        content,
        ...(siteId && { siteId }),
        generatedAt: new Date(),
      },
    });

    // ML Governance: 예측 로그 생성 (승인 워크플로우 연결)
    try {
      await this.prisma.predictionLog.create({
        data: {
          siteId: siteId || '',
          modelVersion: 'claude-opus-4-6',
          predictionType: 'DIFFICULTY',
          inputSnapshot: JSON.stringify(destStats),
          output: content,
          approvalStatus: 'PENDING',
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days
        },
      });
      this.logger.log('난이도 분석 예측 로그 생성 완료 (승인 대기)');
    } catch (error: unknown) {
      // 예측 로그 생성 실패가 인사이트 반환을 막지 않도록 함
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`예측 로그 생성 실패: ${errMsg}`);
    }

    return insight;
  }

  // ======================== Internal ========================

  /**
   * Claude API 호출 (재시도 로직 포함)
   */
  private async callClaude(prompt: string, maxRetries = 3): Promise<string> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI 서비스가 설정되지 않았습니다');
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 16384, // 긴 분석 보고서(난이도/인력배치 테이블 포함) 대응
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          system:
            '당신은 현장 작업 데이터 분석 전문가입니다. ' +
            '한국어로 답변하며, 데이터 기반의 객관적 분석을 제공합니다. ' +
            '개인정보 보호를 위해 작업자는 사번으로만 언급합니다. ' +
            '테이블을 작성할 때는 반드시 헤더와 구분선 이후 데이터 행을 완전히 작성하고, ' +
            '중간에 끊지 않습니다. 토큰 한도가 가까워지면 테이블을 시작하지 말고 다음 번에 완결된 섹션으로 마무리하세요.',
        });

        // 응답이 max_tokens로 잘렸는지 확인
        if (response.stop_reason === 'max_tokens') {
          this.logger.warn(
            `AI 응답이 max_tokens 한도(16384)에 걸려 잘렸습니다. 프롬프트 축약 또는 섹션 분할 필요.`,
          );
        }

        // 텍스트 응답 추출
        const textBlock = response.content.find((block) => block.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          throw new Error('AI 응답에 텍스트가 없습니다');
        }

        this.logger.log(
          `Claude API call success (attempt ${attempt}), ` +
            `input_tokens=${response.usage.input_tokens}, ` +
            `output_tokens=${response.usage.output_tokens}`,
        );

        return textBlock.text;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 429 Too Many Requests: retry-after 헤더 기반 재시도
        if (this.isRateLimitError(error)) {
          const retryAfter = this.getRetryAfterSeconds(error);
          this.logger.warn(
            `Rate limited (attempt ${attempt}/${maxRetries}), waiting ${retryAfter}s`,
          );

          if (attempt < maxRetries) {
            await this.sleep(retryAfter * 1000);
            continue;
          }
        }

        // 서버 오류 (5xx): 지수 백오프 재시도
        if (this.isServerError(error)) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
          this.logger.warn(
            `Server error (attempt ${attempt}/${maxRetries}), backoff ${backoffMs}ms`,
          );

          if (attempt < maxRetries) {
            await this.sleep(backoffMs);
            continue;
          }
        }

        // 그 외 오류는 즉시 실패
        this.logger.error(`Claude API error: ${lastError.message}`);
        break;
      }
    }

    throw new ServiceUnavailableException(
      `AI 분석에 실패했습니다: ${lastError?.message || 'Unknown error'}`,
    );
  }

  /**
   * 통계 요약 데이터 빌드 (Claude에 전달할 간결한 형태)
   */
  private buildStatsSummary(
    workItems: Array<{
      status: string;
      volume: unknown;
      quantity: number;
      startedAt: Date;
      endedAt: Date | null;
      notes?: string | null;
      classification: { code: string };
      startedByWorker: { employeeCode: string };
      assignments: Array<{ worker: { employeeCode: string }; role: string }>;
    }>,
  ) {
    const total = workItems.length;
    const ended = workItems.filter((w) => w.status === 'ENDED').length;
    const active = workItems.filter((w) => w.status === 'ACTIVE').length;

    // 분류별 집계
    const byClassification: Record<string, { count: number; totalVolume: number }> = {};
    workItems.forEach((w) => {
      const code = w.classification.code;
      if (!byClassification[code]) {
        byClassification[code] = { count: 0, totalVolume: 0 };
      }
      byClassification[code].count++;
      byClassification[code].totalVolume += Number(w.volume);
    });

    // 작업자별 집계
    const byWorker: Record<string, { count: number; totalVolume: number }> = {};
    workItems.forEach((w) => {
      const code = w.startedByWorker.employeeCode;
      if (!byWorker[code]) {
        byWorker[code] = { count: 0, totalVolume: 0 };
      }
      byWorker[code].count++;
      byWorker[code].totalVolume += Number(w.volume);
    });

    // 작업 시간 통계 (분) — 중간마감(pauseHistory) 차감한 순수 작업시간
    const durations = workItems
      .filter((w) => w.endedAt)
      .map((w) => calcNetWorkMinutes(w.startedAt, w.endedAt!, w.notes ?? null));

    const avgDuration = durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;

    return {
      totalWorkItems: total,
      endedCount: ended,
      activeCount: active,
      completionRate: total > 0 ? `${Math.round((ended / total) * 100)}%` : 'N/A',
      byClassification,
      byWorker,
      avgDurationMinutes: avgDuration,
    };
  }

  private ensureClientReady() {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 기능을 사용하려면 환경변수를 설정해주세요.',
      );
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'status' in error) {
      return (error as { status: number }).status === 429;
    }
    return false;
  }

  private isServerError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      return status >= 500 && status < 600;
    }
    return false;
  }

  private getRetryAfterSeconds(error: unknown): number {
    if (
      error &&
      typeof error === 'object' &&
      'headers' in error &&
      error.headers &&
      typeof error.headers === 'object'
    ) {
      const headers = error.headers as Record<string, string>;
      const retryAfter = headers['retry-after'];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds;
      }
    }
    return 60; // 기본 60초 대기
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
