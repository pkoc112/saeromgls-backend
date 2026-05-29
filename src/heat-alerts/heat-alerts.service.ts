import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHeatAlertDto } from './dto/create-heat-alert.dto';

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
