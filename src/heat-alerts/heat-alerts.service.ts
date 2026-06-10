import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHeatAlertDto } from './dto/create-heat-alert.dto';
import { CreateHeatRecordDto } from './dto/create-heat-record.dto';

/**
 * 폭염 자가체크 알림 처리
 * - DB 저장
 * - Sentry로 즉시 emit (성훈님 알림용)
 * - Resend로 Gmail 발송 (k20418852@gmail.com 이중 안전망)
 */
@Injectable()
export class HeatAlertsService {
  private readonly logger = new Logger(HeatAlertsService.name);
  private readonly resend: Resend | null;
  private readonly fromEmail: string;
  private readonly notifyEmail: string;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.RESEND_API_KEY;
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@sae-work.com';
    // 운영자 이메일 — 환경 변수로 override 가능
    this.notifyEmail = process.env.HEAT_ALERT_EMAIL || 'k20418852@gmail.com';
  }

  /** 증상 ID → 한글 라벨 매핑 */
  private symptomLabel(id: string): string {
    switch (id) {
      case 'dizziness':
        return '어지러움/현기증';
      case 'headache':
        return '두통';
      case 'nausea':
        return '메스꺼움/구토감';
      default:
        return id;
    }
  }

  private resultLabel(result: 'symptoms' | 'rest'): string {
    return result === 'rest' ? '🛌 작업자가 휴식 선택' : '⚠️ 그래도 작업 진행';
  }

  /**
   * 자가체크 알림 처리 — DB 저장 + Sentry + 이메일
   */
  async create(dto: CreateHeatAlertDto) {
    // 1) DB 저장
    const saved = await this.prisma.heatCheckAlert.create({
      data: {
        workerId: dto.workerId,
        workerName: dto.workerName,
        siteId: dto.siteId ?? null,
        result: dto.result,
        symptoms: dto.symptoms,
        wbgt: dto.wbgt,
        temp: dto.temp,
        humidity: dto.humidity,
        slot: dto.slot,
        reportedAt: new Date(dto.reportedAt),
      },
    });

    const symptomsKo = dto.symptoms.map((s) => this.symptomLabel(s)).join(', ');
    const slotKo = dto.slot === 'AM' ? '오전' : '오후';
    const resultKo = this.resultLabel(dto.result);

    // 2) Sentry로 즉시 emit (fire-and-forget)
    try {
      Sentry.captureMessage(
        `🔥 폭염 자가체크 알림 — ${dto.workerName} (${symptomsKo})`,
        {
          level: 'warning',
          tags: {
            heat_alert: 'true',
            result: dto.result,
            slot: dto.slot,
            site_id: dto.siteId ?? 'unknown',
          },
          extra: {
            workerId: dto.workerId,
            workerName: dto.workerName,
            siteId: dto.siteId,
            symptoms: dto.symptoms,
            symptomsKo,
            wbgt: dto.wbgt,
            temp: dto.temp,
            humidity: dto.humidity,
            slot: slotKo,
            result: resultKo,
            reportedAt: dto.reportedAt,
          },
        },
      );
    } catch (err) {
      this.logger.warn(`Sentry capture 실패: ${err}`);
    }

    // 3) Gmail 발송 (fire-and-forget)
    if (this.resend) {
      const subject = `[새롬GLS] 폭염 자가체크 알림 — ${dto.workerName} (${slotKo})`;
      const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <div style="background: #FEF2F2; border-left: 4px solid #DC2626; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #B91C1C; margin: 0 0 8px;">🔥 폭염 자가체크 알림</h2>
            <p style="color: #991B1B; margin: 0; font-size: 14px;">
              작업자가 온열질환 의심 증상을 보고했습니다.
            </p>
          </div>

          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B; width: 110px;">작업자</td>
              <td style="padding: 10px 0; font-weight: 700;">${dto.workerName}</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">증상</td>
              <td style="padding: 10px 0; color: #B91C1C; font-weight: 700;">${symptomsKo}</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">작업자 선택</td>
              <td style="padding: 10px 0; font-weight: 700;">${resultKo}</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">시간대</td>
              <td style="padding: 10px 0;">${slotKo} (${new Date(dto.reportedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">체감온도 (WBGT)</td>
              <td style="padding: 10px 0; font-weight: 700; color: #DC2626;">${dto.wbgt}°C</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">기온 / 습도</td>
              <td style="padding: 10px 0;">${dto.temp}°C / ${dto.humidity}%</td>
            </tr>
          </table>

          <div style="background: #F8FAFC; padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 13px; color: #475569;">
            <strong style="color: #0F172A;">권장 조치</strong><br>
            ${
              dto.result === 'rest'
                ? '작업자가 휴식을 선택했습니다. 응급처치/체온 확인 후 충분한 회복 시간을 보장하세요.'
                : '작업자가 "그래도 작업" 을 선택했습니다. 직접 상태 확인 및 작업 강도 조정을 고려하세요.'
            }
          </div>

          <p style="font-size: 12px; color: #94A3B8; margin-top: 24px; text-align: center;">
            새롬GLS 작업현황 공유 시스템 — 자동 발송
          </p>
        </div>
      `;
      try {
        await this.resend.emails.send({
          from: this.fromEmail,
          to: this.notifyEmail,
          subject,
          html,
        });
      } catch (err) {
        this.logger.warn(`Resend 발송 실패: ${err}`);
      }
    } else {
      this.logger.warn('RESEND_API_KEY 미설정 — 이메일 발송 스킵');
    }

    return { success: true, id: saved.id };
  }

  /**
   * 시간별 체감온도(WBGT) 기록 — 시간 단위 upsert
   * - 모바일이 30분 주기 날씨 갱신 시 보고 → 서버에서 정시(hour) 절삭 후 dedup
   * - 같은 시간대 재보고는 최신 값으로 갱신 (마지막 관측 우선)
   */
  async recordHourly(siteId: string | null, dto: CreateHeatRecordDto) {
    const recordedAt = new Date();
    recordedAt.setMinutes(0, 0, 0); // 정시 절삭

    const data = {
      wbgt: dto.wbgt,
      temp: dto.temp,
      humidity: dto.humidity,
      level: dto.level,
    };

    // siteId가 null일 수 있어 unique upsert 대신 findFirst → update/create
    // (Postgres unique는 NULL을 distinct 취급 → null 사이트는 수동 dedup)
    const existing = await this.prisma.heatHourlyRecord.findFirst({
      where: { siteId, recordedAt },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.heatHourlyRecord.update({
        where: { id: existing.id },
        data,
      });
      return { success: true, id: existing.id, updated: true };
    }
    try {
      const saved = await this.prisma.heatHourlyRecord.create({
        data: { siteId, recordedAt, ...data },
      });
      return { success: true, id: saved.id, updated: false };
    } catch (err: unknown) {
      // 동시 보고 race로 unique 충돌(P2002) 시 — 이미 기록됨, 성공 처리
      if ((err as { code?: string })?.code === 'P2002') {
        return { success: true, updated: true };
      }
      throw err;
    }
  }

  /**
   * 시간별 체감온도 기록 조회 (관리자 웹 — KST 하루 단위)
   * @param dateStr 'YYYY-MM-DD' (KST). 미지정 시 KST 오늘.
   */
  async findHourlyRecords(siteId: string | null | undefined, dateStr?: string) {
    const kstNow = new Date(Date.now() + 9 * 3600_000);
    const ymd =
      dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
        ? dateStr
        : kstNow.toISOString().slice(0, 10);
    const start = new Date(`${ymd}T00:00:00+09:00`);
    const end = new Date(start.getTime() + 24 * 3600_000);

    const records = await this.prisma.heatHourlyRecord.findMany({
      where: {
        // siteId NULL 호환 (기존 데이터 보호 패턴 — 함정 #11)
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
        recordedAt: { gte: start, lt: end },
      },
      orderBy: { recordedAt: 'asc' },
    });
    return { date: ymd, records };
  }

  /**
   * 월별 체감온도 요약 (관리자 웹 — KST 월 단위)
   * - 일별: 최고/평균 WBGT, 최고 단계, 기록 시간수
   * - 요약: 기록일수, 주의+/경고+/위험 일수, 월 최고 WBGT(+날짜)
   * @param monthStr 'YYYY-MM' (KST). 미지정 시 KST 이번 달.
   */
  async findMonthlyStats(siteId: string | null | undefined, monthStr?: string) {
    const kstNow = new Date(Date.now() + 9 * 3600_000);
    const ym =
      monthStr && /^\d{4}-\d{2}$/.test(monthStr)
        ? monthStr
        : kstNow.toISOString().slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const start = new Date(`${ym}-01T00:00:00+09:00`);
    const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const end = new Date(`${nextYm}-01T00:00:00+09:00`);

    const rows = await this.prisma.heatHourlyRecord.findMany({
      where: {
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
        recordedAt: { gte: start, lt: end },
      },
      orderBy: { recordedAt: 'asc' },
      select: { wbgt: true, level: true, recordedAt: true },
    });

    // KOSHA 단계 심각도 순위
    const RANK: Record<string, number> = {
      normal: 0,
      attention: 1,
      caution: 2,
      warning: 3,
      danger: 4,
    };
    const LEVELS = ['normal', 'attention', 'caution', 'warning', 'danger'];

    // 일별 집계 (KST 날짜 기준)
    const dayMap = new Map<
      string,
      { max: number; sum: number; count: number; maxRank: number }
    >();
    for (const r of rows) {
      const kstDate = new Date(r.recordedAt.getTime() + 9 * 3600_000)
        .toISOString()
        .slice(0, 10);
      const wbgt = Number(r.wbgt);
      const rank = RANK[r.level] ?? 0;
      const d = dayMap.get(kstDate);
      if (d) {
        d.max = Math.max(d.max, wbgt);
        d.sum += wbgt;
        d.count += 1;
        d.maxRank = Math.max(d.maxRank, rank);
      } else {
        dayMap.set(kstDate, { max: wbgt, sum: wbgt, count: 1, maxRank: rank });
      }
    }

    const daysArr = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        maxWbgt: Math.round(d.max * 10) / 10,
        avgWbgt: Math.round((d.sum / d.count) * 10) / 10,
        maxLevel: LEVELS[d.maxRank],
        hours: d.count,
      }));

    const maxDay = daysArr.reduce(
      (best, d) => (d.maxWbgt > (best?.maxWbgt ?? -Infinity) ? d : best),
      null as (typeof daysArr)[number] | null,
    );

    return {
      month: ym,
      days: daysArr,
      summary: {
        recordedDays: daysArr.length,
        cautionPlusDays: daysArr.filter((d) => RANK[d.maxLevel] >= 2).length,
        warningPlusDays: daysArr.filter((d) => RANK[d.maxLevel] >= 3).length,
        dangerDays: daysArr.filter((d) => RANK[d.maxLevel] >= 4).length,
        maxWbgt: maxDay?.maxWbgt ?? null,
        maxWbgtDate: maxDay?.date ?? null,
      },
    };
  }

  /**
   * 알림 목록 조회 (관리자 페이지용 — 향후 사용)
   */
  async findAll(siteId: string | null | undefined, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.heatCheckAlert.findMany({
      where: {
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
