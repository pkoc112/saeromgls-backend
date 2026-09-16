import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from '../utils/pii-mask';

/**
 * 알림 이벤트 종류
 * - heat: 폭염 자가체크/예보 알림
 * - stuck_work: 종료 누락(장시간 진행) 작업 알림
 * - subscription: 구독 만료 임박/만료 알림
 * - digest: MASTER 운영 다이제스트 (고객 발송 아님)
 * - summary: 일일/주간 작업 요약
 */
export type NotificationEvent = 'heat' | 'stuck_work' | 'subscription' | 'digest' | 'summary';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  cc?: string | string[];
}

export interface SendMailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** TenantSettings.settings JSON 의 notifications 키 형태 */
export interface TenantNotificationSettings {
  default?: string[] | string;
  heat?: string[] | string;
  stuck_work?: string[] | string;
  subscription?: string[] | string;
  summary?: string[] | string;
  summaryDaily?: boolean;
  summaryWeekly?: boolean;
}

/**
 * 알림 허브 (#25)
 * - Resend 래퍼: API 키 없으면 throw 하지 않고 warn + {ok:false,error:'no-api-key'}
 * - 수신자 결정: 센터별 TenantSettings → alertEmail → 사이트 관리자(이메일 인증) → []
 * - MASTER 폴백(masterEmail)은 호출자가 결정 (고객 발송 이벤트에 운영자 메일이 섞이지 않도록)
 *
 * ★ 순환 import 금지: 이 모듈은 PrismaModule 에만 의존한다.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend | null;
  private readonly fromEmail: string;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.RESEND_API_KEY;
    this.resend = apiKey ? new Resend(apiKey) : null;
    // 환경변수에 섞인 공백/줄바꿈은 from 주소를 깨뜨려 Resend 가 422 로 거부한다 (눈에 보이지 않음)
    this.fromEmail = (process.env.RESEND_FROM_EMAIL || '').trim() || 'noreply@sae-work.com';
    if (!this.resend) {
      this.logger.warn('RESEND_API_KEY 미설정 — 알림 메일은 발송되지 않습니다 (로그만 기록)');
    }
  }

  isConfigured(): boolean {
    return this.resend !== null;
  }

  /** 운영자(MASTER) 이메일 — 환경 변수로 override 가능 */
  masterEmail(): string {
    return process.env.HEAT_ALERT_EMAIL || 'k20418852@gmail.com';
  }

  /**
   * 문자열/배열/콤마문자열을 이메일 배열로 정규화
   * - trim · 소문자 · '@' 포함만 · 중복 제거 · 순서 유지
   * - 구분자: 콤마, 세미콜론, 줄바꿈, 공백
   */
  private normalizeList(input: unknown): string[] {
    const raw: string[] = [];
    if (Array.isArray(input)) {
      for (const v of input) if (typeof v === 'string') raw.push(...v.split(/[,;\s]+/));
    } else if (typeof input === 'string') {
      raw.push(...input.split(/[,;\s]+/));
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of raw) {
      const e = r.trim().toLowerCase();
      if (!e || !e.includes('@') || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
    return out;
  }

  /**
   * 메일 발송 (Resend)
   * - 절대 throw 하지 않음 — 크론/서비스 흐름이 메일 실패로 끊기지 않도록
   * - to/cc 는 dedup·trim·소문자, cc 에서 to 와 겹치는 주소 제거
   */
  async sendMail(opts: SendMailOptions): Promise<SendMailResult> {
    const to = this.normalizeList(opts.to);
    const cc = this.normalizeList(opts.cc).filter((e) => !to.includes(e));

    if (to.length === 0) {
      this.logger.warn(`수신자 없음 — 메일 미발송: "${opts.subject}"`);
      return { ok: false, error: 'no-recipients' };
    }
    if (!this.resend) {
      this.logger.warn(
        `RESEND_API_KEY 미설정 — 메일 미발송: "${opts.subject}" → ${to.map(maskEmail).join(', ')}`,
      );
      return { ok: false, error: 'no-api-key' };
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: `새롬 GLS <${this.fromEmail}>`,
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject: opts.subject,
        html: opts.html,
      });
      if (error) {
        const msg = error.message || JSON.stringify(error);
        this.logger.error(`메일 발송 실패: "${opts.subject}" → ${to.map(maskEmail).join(', ')}: ${msg}`);
        return { ok: false, error: msg };
      }
      if (!data?.id) {
        this.logger.error('메일 서비스가 발송 접수 ID를 반환하지 않았습니다');
        return { ok: false, error: 'missing-message-id' };
      }
      this.logger.log(
        `메일 발송 완료: "${opts.subject}" → ${to.map(maskEmail).join(', ')}` +
          (cc.length ? ` (cc ${cc.map(maskEmail).join(', ')})` : '') +
          (data?.id ? ` [${data.id}]` : ''),
      );
      return { ok: true, id: data?.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`메일 발송 예외: "${opts.subject}": ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * 이벤트별 수신자 결정 (heat-alerts.service resolveRecipient 일반화)
   * 우선순위:
   *   1) TenantSettings.settings.notifications[eventType] (string[] 또는 콤마문자열)
   *   2) TenantSettings.settings.notifications.default
   *   3) TenantSettings.settings.alertEmail (콤마 허용 — 기존 폭염 알림 호환)
   *   4) 해당 사업장 ACTIVE ADMIN/SUPERVISOR 중 email && emailVerified
   *   5) [] — MASTER 폴백 여부는 호출자가 결정
   * siteId 가 없으면 [] (센터 귀속이 안 되는 데이터는 호출자가 처리)
   */
  async resolveRecipients(
    siteId: string | null | undefined,
    eventType: NotificationEvent,
  ): Promise<string[]> {
    if (!siteId) return [];

    // 1~3) 센터 설정
    try {
      const ts = await this.prisma.tenantSettings.findFirst({
        where: { siteId },
        select: { settings: true },
      });
      if (ts?.settings) {
        const parsed = JSON.parse(ts.settings) as {
          notifications?: TenantNotificationSettings;
          alertEmail?: unknown;
        };
        const notif = parsed?.notifications;
        if (notif && typeof notif === 'object') {
          const specific = this.normalizeList((notif as Record<string, unknown>)[eventType]);
          if (specific.length > 0) return specific;
          const def = this.normalizeList(notif.default);
          if (def.length > 0) return def;
        }
        const alertEmail = this.normalizeList(parsed?.alertEmail);
        if (alertEmail.length > 0) return alertEmail;
      }
    } catch (err) {
      this.logger.warn(`알림 수신자 설정 조회 실패(site ${siteId}, ${eventType}) — 관리자 폴백: ${err}`);
    }

    // 4) 사이트 관리자/반장 (이메일 인증 완료된 계정만)
    try {
      const admins = await this.prisma.worker.findMany({
        where: {
          siteId,
          status: 'ACTIVE',
          role: { in: ['ADMIN', 'SUPERVISOR'] },
          emailVerified: true,
          email: { not: null },
        },
        select: { email: true },
        orderBy: { createdAt: 'asc' },
      });
      return this.normalizeList(admins.map((a) => a.email).filter((e): e is string => !!e));
    } catch (err) {
      this.logger.warn(`사이트 관리자 이메일 조회 실패(site ${siteId}, ${eventType}): ${err}`);
      return [];
    }
  }
}
