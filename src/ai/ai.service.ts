import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';

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
        classification: { select: { code: true } },
        startedByWorker: { select: { employeeCode: true } },
      },
    });

    if (workItems.length === 0) {
      return { message: '해당 기간에 작업 데이터가 없습니다', anomalies: [] };
    }

    // 이상 탐지를 위한 데이터 준비
    const analysisData = workItems.map((item) => ({
      status: item.status,
      classification: item.classification.code,
      worker_code: item.startedByWorker.employeeCode,
      volume: Number(item.volume),
      quantity: item.quantity,
      started_at: item.startedAt.toISOString(),
      ended_at: item.endedAt?.toISOString() || null,
      duration_minutes: item.endedAt
        ? Math.round((item.endedAt.getTime() - item.startedAt.getTime()) / 60000)
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
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          system:
            '당신은 현장 작업 데이터 분석 전문가입니다. ' +
            '한국어로 답변하며, 데이터 기반의 객관적 분석을 제공합니다. ' +
            '개인정보 보호를 위해 작업자는 사번으로만 언급합니다.',
        });

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

    // 작업 시간 통계 (분)
    const durations = workItems
      .filter((w) => w.endedAt)
      .map((w) => (w.endedAt!.getTime() - w.startedAt.getTime()) / 60000);

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
