import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../common/notifications/notifications.service';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHeatAlertDto } from './dto/create-heat-alert.dto';
import { CreateHeatRecordDto } from './dto/create-heat-record.dto';
import {
  breakOverlapMs,
  loadBreakConfigResolver,
} from '../common/utils/net-work-minutes';

/** KOSHA 5단계 (mobile/src/utils/heat-utils.ts classifyHeatRisk 와 동일 임계 28/31/33/35) */
type HeatLevel = 'normal' | 'attention' | 'caution' | 'warning' | 'danger';

/** 노출 리포트 집계 키 — 5단계 + 기록 없음(unknown, 정상으로 간주 금지) */
type ExposureKey = HeatLevel | 'unknown';
const EXPOSURE_KEYS: ExposureKey[] = ['normal', 'attention', 'caution', 'warning', 'danger', 'unknown'];

/** 노출 리포트 참여자 최소 정보 (startedByWorker / assignments.worker 공통) */
interface ExposureWorkerRef {
  id: string;
  name: string;
  employeeCode: string;
  role?: string | null;
}

const HEAT_LEVELS: Record<
  HeatLevel,
  { label: string; rank: number; color: string; bg: string; workRule: string }
> = {
  normal: { label: '정상', rank: 0, color: '#15803D', bg: '#F0FDF4', workRule: '일반 작업 가능' },
  attention: { label: '관심', rank: 1, color: '#A16207', bg: '#FEFCE8', workRule: '음용수 비치, 작업자 교육 권장' },
  caution: { label: '주의', rank: 2, color: '#C2410C', bg: '#FFF7ED', workRule: '매시간 10~15분 휴식 권장' },
  warning: { label: '경고', rank: 3, color: '#B91C1C', bg: '#FEF2F2', workRule: '매시간 15~20분 휴식, 작업 단축 검토' },
  danger: { label: '위험', rank: 4, color: '#7E22CE', bg: '#FAF5FF', workRule: '옥외 작업 중지 권고 (법령 기준)' },
};

function heatLevelOf(wbgt: number): HeatLevel {
  if (wbgt < 28) return 'normal';
  if (wbgt < 31) return 'attention';
  if (wbgt < 33) return 'caution';
  if (wbgt < 35) return 'warning';
  return 'danger';
}

/** 구독이 이 상태면 고객 발송 제외 (MASTER 다이제스트는 별도) */
const INACTIVE_SUBSCRIPTION_STATUSES = ['EXPIRED', 'SUSPENDED', 'CANCELLED'];

interface HourlyForecast {
  time: string; // 'YYYY-MM-DDTHH:mm' (Asia/Seoul)
  hour: number;
  temp: number;
  humidity: number;
  wbgt: number;
}

/**
 * 폭염 자가체크 알림 처리
 * - DB 저장
 * - Sentry로 즉시 emit (성훈님 알림용)
 * - Resend로 Gmail 발송 — 센터별 수신자(복수, 콤마 구분) + 운영자(HEAT_ALERT_EMAIL) 항상 CC
 * - 폭염 예보 사전 알림(runHeatForecastNotices) — 크론 06:00 KST, 근무시간대 최고 WBGT 주의 이상이면 발송
 */
@Injectable()
export class HeatAlertsService {
  private readonly logger = new Logger(HeatAlertsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 날씨/WBGT 기본 좌표 (대구 동구 물류센터) — 센터 미설정 시 폴백 */
  private readonly DEFAULT_LAT = 35.92;
  private readonly DEFAULT_LON = 128.66;
  /** 좌표 미설정 폴백 경고를 이미 emit한 사업장 (Sentry 스팸 방지, 콜드스타트 시 리셋) */
  private readonly warnedFallbackSites = new Set<string>();

  /**
   * 모바일용 센터 설정 조회 (개통 분석 P0-2b):
   * 해당 사업장 TenantSettings JSON 의 latitude/longitude 를 반환.
   * 미설정/파싱 실패 시 대구 기본 좌표로 폴백 → 신규 센터가 자기 지역 날씨로 폭염 판정.
   */
  async getSiteConfig(siteId: string | null) {
    let latitude = this.DEFAULT_LAT;
    let longitude = this.DEFAULT_LON;
    // 화면 keep-on 운영시간 — 미설정 시 06~19시(기존 대구 동작 유지)
    let workStartHour = 6;
    let workEndHour = 19;
    let coordsResolved = false;
    if (siteId) {
      try {
        const ts = await this.prisma.tenantSettings.findFirst({
          where: { siteId },
          select: { settings: true },
        });
        if (ts?.settings) {
          const p = JSON.parse(ts.settings);
          const lat = Number(p?.latitude);
          const lon = Number(p?.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
            latitude = lat;
            longitude = lon;
            coordsResolved = true;
          }
          const ws = Number(p?.workStartHour);
          const we = Number(p?.workEndHour);
          if (Number.isInteger(ws) && ws >= 0 && ws <= 23) workStartHour = ws;
          if (Number.isInteger(we) && we >= 1 && we <= 24 && we > workStartHour) workEndHour = we;
        }
      } catch (err) {
        this.logger.warn(`site-config 조회 실패(site ${siteId}) — 기본값 폴백: ${err}`);
      }

      // ★ 좌표 미설정 폴백 경고: 신규(타 지역) 센터가 조용히 대구 날씨로 폭염을 판정하는
      //   산업안전 사고를 방지. 로그는 매번, Sentry는 사업장당 1회만 emit.
      if (!coordsResolved) {
        this.logger.warn(
          `[heat] site ${siteId} 좌표 미설정 → 대구 기본 좌표(${this.DEFAULT_LAT},${this.DEFAULT_LON})로 폴백. ` +
            `해당 센터의 온열질환 판정이 실제 지역과 다를 수 있음 — 설정에서 위경도를 입력하세요.`,
        );
        if (!this.warnedFallbackSites.has(siteId)) {
          this.warnedFallbackSites.add(siteId);
          try {
            Sentry.captureMessage(
              `heat-config: site ${siteId} 좌표 미설정 → 대구 좌표 폴백 (지역 불일치 위험)`,
              'warning',
            );
          } catch {
            /* Sentry 미초기화 시 무시 */
          }
        }
      }
    }
    return { latitude, longitude, workStartHour, workEndHour, coordsResolved };
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

  /** 메일 본문 HTML 이스케이프 (센터명/작업자명 등 사용자 입력값) */
  private esc(value: unknown): string {
    const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
    return String(value ?? '').replace(/[<>&"]/g, (c) => map[c] ?? c);
  }

  /**
   * 공통 허브의 센터별 heat → default → alertEmail → 인증된 관리자 순서를 따른다.
   * 폭염 신고는 수신자가 없어도 기존 정책대로 운영자에게 전달한다.
   */
  private async resolveRecipient(siteId: string | null): Promise<string[]> {
    const recipients = await this.notifications.resolveRecipients(siteId, 'heat');
    return recipients.length ? recipients : [this.notifications.masterEmail().trim().toLowerCase()];
  }

  /** 운영자(HEAT_ALERT_EMAIL) CC — to 에 이미 포함돼 있으면 중복 수신 방지를 위해 생략 */
  private operatorCc(to: string[]): string[] {
    const op = this.notifications.masterEmail().trim().toLowerCase();
    return op && !to.includes(op) ? [op] : [];
  }

  /** 센터명 조회 (메일 제목/본문용) — 미지정/실패 시 null */
  private async resolveSiteName(siteId: string | null): Promise<string | null> {
    if (!siteId) return null;
    try {
      const site = await this.prisma.site.findUnique({
        where: { id: siteId },
        select: { name: true },
      });
      return site?.name ?? null;
    } catch (err) {
      this.logger.warn(`센터명 조회 실패(site ${siteId}): ${err}`);
      return null;
    }
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

    // 3) 메일 발송 결과와 신고 저장 결과를 구분한다.
    const siteId = dto.siteId ?? null;
    const [recipients, siteName] = await Promise.all([
      this.resolveRecipient(siteId),
      this.resolveSiteName(siteId),
    ]);
    const cc = this.operatorCc(recipients);
    let emailSent = false;
    if (this.notifications.isConfigured()) {
      const siteTag = siteName ? `[${siteName}]` : '';
      const subject = `[새롬GLS]${siteTag} 폭염 자가체크 알림 — ${dto.workerName} (${slotKo})`;
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
              <td style="padding: 10px 0; color: #64748B; width: 110px;">센터</td>
              <td style="padding: 10px 0; font-weight: 700;">${this.esc(siteName ?? '미지정')}</td>
            </tr>
            <tr style="border-bottom: 1px solid #E2E8F0;">
              <td style="padding: 10px 0; color: #64748B;">작업자</td>
              <td style="padding: 10px 0; font-weight: 700;">${this.esc(dto.workerName)}</td>
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
        const delivery = await this.notifications.sendMail({
          to: recipients,
          ...(cc.length > 0 ? { cc } : {}),
          subject,
          html,
        });
        emailSent = delivery.ok;
      } catch (err) {
        this.logger.warn(`Resend 발송 실패: ${err}`);
      }
    } else {
      this.logger.warn('RESEND_API_KEY 미설정 — 이메일 발송 스킵');
    }

    return { success: true, id: saved.id, emailSent };
  }

  // ────────────────────────────────────────────────────────────
  // #18 폭염 예보 사전 알림 (크론 heat-forecast-notice, 06:00 KST)
  // ────────────────────────────────────────────────────────────

  /** 포화수증기압 (Magnus 공식, hPa) — mobile/src/utils/heat-utils.ts 와 동일식 */
  private saturationVaporPressure(tempC: number): number {
    return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
  }

  /** WBGT 간이식 (0.567T + 0.393e + 3.94, 소수 1자리) — mobile calculateWBGT 이식 */
  private calculateWBGT(tempC: number, humidityPct: number): number {
    const e = (humidityPct / 100) * this.saturationVaporPressure(tempC);
    return Math.round((0.567 * tempC + 0.393 * e + 3.94) * 10) / 10;
  }

  /**
   * Open-Meteo 오늘(KST) 시간별 예보 조회 → WBGT 계산.
   * 네트워크/응답 오류 시 throw (호출자가 사이트별 try/catch).
   */
  private async fetchHourlyForecast(lat: number, lon: number): Promise<HourlyForecast[]> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,relative_humidity_2m&timezone=Asia/Seoul&forecast_days=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Open-Meteo 응답 오류 (HTTP ${res.status})`);
      const json = (await res.json()) as {
        hourly?: {
          time?: string[];
          temperature_2m?: (number | null)[];
          relative_humidity_2m?: (number | null)[];
        };
      };
      const times = json?.hourly?.time ?? [];
      const temps = json?.hourly?.temperature_2m ?? [];
      const hums = json?.hourly?.relative_humidity_2m ?? [];
      const rows: HourlyForecast[] = [];
      for (let i = 0; i < times.length; i++) {
        const temp = Number(temps[i]);
        const humidity = Number(hums[i]);
        const hour = Number(String(times[i]).slice(11, 13));
        if (!Number.isFinite(temp) || !Number.isFinite(humidity) || !Number.isInteger(hour)) continue;
        rows.push({ time: times[i], hour, temp, humidity, wbgt: this.calculateWBGT(temp, humidity) });
      }
      if (rows.length === 0) throw new Error('Open-Meteo 예보 데이터 없음');
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 예보 메일 본문 — 요약 표 + 시간대별 표 + 휴식 권고 */
  private buildForecastHtml(args: {
    siteName: string;
    dateLabel: string;
    workStartHour: number;
    workEndHour: number;
    rows: HourlyForecast[];
    peak: HourlyForecast;
  }): string {
    const { siteName, dateLabel, workStartHour, workEndHour, rows, peak } = args;
    const peakLevel = heatLevelOf(peak.wbgt);
    const peakMeta = HEAT_LEVELS[peakLevel];
    const cautionHours = rows.filter((r) => HEAT_LEVELS[heatLevelOf(r.wbgt)].rank >= HEAT_LEVELS.caution.rank);
    const cautionRange =
      cautionHours.length > 0
        ? `${cautionHours[0].hour}시 ~ ${cautionHours[cautionHours.length - 1].hour}시 (${cautionHours.length}시간)`
        : '없음';

    const hourRows = rows
      .map((r) => {
        const lv = heatLevelOf(r.wbgt);
        const m = HEAT_LEVELS[lv];
        const isPeak = r.time === peak.time;
        const bg = m.rank >= HEAT_LEVELS.caution.rank ? m.bg : '#FFFFFF';
        return `
            <tr style="background: ${bg}; ${isPeak ? 'font-weight: 700;' : ''}">
              <td style="padding: 6px 8px; border-bottom: 1px solid #E2E8F0;">${String(r.hour).padStart(2, '0')}시</td>
              <td style="padding: 6px 8px; border-bottom: 1px solid #E2E8F0; text-align: right;">${r.temp.toFixed(1)}°C</td>
              <td style="padding: 6px 8px; border-bottom: 1px solid #E2E8F0; text-align: right;">${Math.round(r.humidity)}%</td>
              <td style="padding: 6px 8px; border-bottom: 1px solid #E2E8F0; text-align: right; color: ${m.color};">${r.wbgt.toFixed(1)}°</td>
              <td style="padding: 6px 8px; border-bottom: 1px solid #E2E8F0; color: ${m.color};">${m.label}${isPeak ? ' ★' : ''}</td>
            </tr>`;
      })
      .join('');

    return `
      <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
        <div style="background: ${peakMeta.bg}; border-left: 4px solid ${peakMeta.color}; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: ${peakMeta.color}; margin: 0 0 8px;">☀️ 오늘 폭염 예보 — ${this.esc(siteName)}</h2>
          <p style="color: #334155; margin: 0; font-size: 14px;">
            근무시간대 최고 체감온도 <strong style="color: ${peakMeta.color};">${peak.wbgt.toFixed(1)}° (${peakMeta.label})</strong>,
            ${peak.hour}시 전후 예상. 미리 휴식·음용수 계획을 세워주세요.
          </p>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
          <tr style="border-bottom: 1px solid #E2E8F0;">
            <td style="padding: 10px 0; color: #64748B; width: 130px;">센터</td>
            <td style="padding: 10px 0; font-weight: 700;">${this.esc(siteName)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #E2E8F0;">
            <td style="padding: 10px 0; color: #64748B;">날짜</td>
            <td style="padding: 10px 0;">${this.esc(dateLabel)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #E2E8F0;">
            <td style="padding: 10px 0; color: #64748B;">근무시간대</td>
            <td style="padding: 10px 0;">${workStartHour}시 ~ ${workEndHour}시</td>
          </tr>
          <tr style="border-bottom: 1px solid #E2E8F0;">
            <td style="padding: 10px 0; color: #64748B;">최고 체감온도</td>
            <td style="padding: 10px 0; font-weight: 700; color: ${peakMeta.color};">${peak.wbgt.toFixed(1)}° (${peakMeta.label}) — ${peak.hour}시</td>
          </tr>
          <tr style="border-bottom: 1px solid #E2E8F0;">
            <td style="padding: 10px 0; color: #64748B;">주의 이상 시간대</td>
            <td style="padding: 10px 0;">${cautionRange}</td>
          </tr>
        </table>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="background: #F1F5F9; color: #475569;">
              <th style="padding: 8px; text-align: left;">시각</th>
              <th style="padding: 8px; text-align: right;">기온</th>
              <th style="padding: 8px; text-align: right;">습도</th>
              <th style="padding: 8px; text-align: right;">체감온도</th>
              <th style="padding: 8px; text-align: left;">단계</th>
            </tr>
          </thead>
          <tbody>${hourRows}
          </tbody>
        </table>

        <div style="background: #F8FAFC; padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 13px; color: #475569;">
          <strong style="color: #0F172A;">휴식 권고 (KOSHA 폭염 단계별 작업관리)</strong><br>
          최고 단계 <strong style="color: ${peakMeta.color};">${peakMeta.label}</strong>: ${peakMeta.workRule}<br>
          · 물·그늘·휴식 3대 수칙 — 시원한 물을 자주 마시고, 그늘에서 규칙적으로 쉬게 해주세요.<br>
          · 주의 이상 시간대에는 태블릿 자가체크(오전/오후)를 반드시 실시하고, 어지러움·두통·메스꺼움 호소 시 즉시 작업을 중단시키세요.<br>
          · 고령·기저질환 작업자는 위 시간대의 작업 강도를 낮추거나 실내 작업으로 조정하세요.
        </div>

        <p style="font-size: 12px; color: #94A3B8; margin-top: 24px; text-align: center;">
          예보 출처: Open-Meteo (체감온도는 기온·습도 기반 WBGT 간이식). 실제 현장 온도와 다를 수 있습니다.<br>
          새롬GLS 작업현황 공유 시스템 — 자동 발송
        </p>
      </div>
    `;
  }

  /**
   * 폭염 예보 사전 알림 (계약 [F]):
   * 최상위 활성 사이트를 순회하며 오늘(KST) 근무시간대 최고 WBGT 를 예측하고,
   * 주의(31°) 이상이면 센터 수신자(notifications.heat + 운영자 CC)에게 메일 발송.
   * - 좌표 미설정(coordsResolved=false) 센터 skip (대구 폴백 좌표로 타 지역 판정 금지)
   * - 구독 EXPIRED/SUSPENDED/CANCELLED 센터 skip (구독 기록 없는 센터는 발송 대상)
   * - 사이트별 try/catch → errors[] (한 센터 실패가 나머지를 막지 않음), 함수 자체는 throw 하지 않음
   * - 발송은 사이트별로 즉시 수행되므로 크론 래퍼는 idempotent:false 권장 (재시도 시 중복 발송 방지)
   */
  async runHeatForecastNotices(): Promise<{ sent: number; skipped: number; errors: string[] }> {
    const result = { sent: 0, skipped: 0, errors: [] as string[] };

    if (!this.notifications.isConfigured()) {
      this.logger.warn('RESEND_API_KEY 미설정 — 폭염 예보 알림 발송 불가');
      result.errors.push('RESEND_API_KEY 미설정 — 폭염 예보 알림 발송 불가');
      return result;
    }

    const sites = await this.prisma.site.findMany({
      where: { parentSiteId: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const site of sites) {
      try {
        // 구독 종료 센터는 고객 발송 제외 (status 대소문자 혼용 대비 toUpperCase)
        const sub = await this.prisma.subscription.findFirst({
          where: { siteId: site.id },
          orderBy: { createdAt: 'desc' },
          select: { status: true },
        });
        const subStatus = String(sub?.status ?? '').toUpperCase();
        if (INACTIVE_SUBSCRIPTION_STATUSES.includes(subStatus)) {
          this.logger.log(`[heat-forecast] ${site.name}: 구독 ${subStatus} → skip`);
          result.skipped += 1;
          continue;
        }

        const cfg = await this.getSiteConfig(site.id);
        if (!cfg.coordsResolved) {
          this.logger.log(`[heat-forecast] ${site.name}: 좌표 미설정 → skip`);
          result.skipped += 1;
          continue;
        }

        const forecast = await this.fetchHourlyForecast(cfg.latitude, cfg.longitude);
        const endHour = Math.min(cfg.workEndHour, 23);
        const rows = forecast.filter((r) => r.hour >= cfg.workStartHour && r.hour <= endHour);
        if (rows.length === 0) {
          this.logger.log(`[heat-forecast] ${site.name}: 근무시간대(${cfg.workStartHour}~${cfg.workEndHour}시) 예보 없음 → skip`);
          result.skipped += 1;
          continue;
        }

        const peak = rows.reduce((best, r) => (r.wbgt > best.wbgt ? r : best), rows[0]);
        const level = heatLevelOf(peak.wbgt);
        const meta = HEAT_LEVELS[level];
        if (meta.rank < HEAT_LEVELS.caution.rank) {
          this.logger.log(
            `[heat-forecast] ${site.name}: 최고 WBGT ${peak.wbgt.toFixed(1)}°(${meta.label}) < 주의 → skip`,
          );
          result.skipped += 1;
          continue;
        }

        const to = await this.resolveRecipient(site.id);
        const cc = this.operatorCc(to);
        const dateLabel = new Date(`${peak.time.slice(0, 10)}T00:00:00+09:00`).toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          weekday: 'short',
        });
        const subject = `[새롬GLS][${site.name}] 오늘 폭염 예보: 최고 체감온도 ${peak.wbgt.toFixed(1)}°(${meta.label}) ${peak.hour}시`;
        const html = this.buildForecastHtml({
          siteName: site.name,
          dateLabel,
          workStartHour: cfg.workStartHour,
          workEndHour: cfg.workEndHour,
          rows,
          peak,
        });

        const delivery = await this.notifications.sendMail({
          to,
          ...(cc.length > 0 ? { cc } : {}),
          subject,
          html,
        });
        if (!delivery.ok) {
          result.errors.push(`${site.name}: 발송 실패 — ${delivery.error || 'unknown'}`);
          continue;
        }
        result.sent += 1;
        this.logger.log(
          `[heat-forecast] ${site.name}: 발송 완료 (${meta.label} ${peak.wbgt.toFixed(1)}° ${peak.hour}시, to ${to.length}명, cc ${cc.length}명)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${site.name}: ${msg}`);
        this.logger.warn(`[heat-forecast] ${site.name}: 처리 실패 — ${msg}`);
      }
    }

    this.logger.log(
      `[heat-forecast] 완료 — sent ${result.sent}, skipped ${result.skipped}, errors ${result.errors.length}`,
    );
    return result;
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
   * 시간별 체감온도 기록 조회 (관리자 웹 — KST 기간 단위)
   * @param fromStr 'YYYY-MM-DD' (KST) 시작일. 미지정 시 KST 오늘.
   * @param toStr   'YYYY-MM-DD' (KST) 종료일. 미지정 시 fromStr.
   * 기간은 [from 00:00, to 24:00) 으로 양끝 포함. 과도한 범위는 92일로 제한.
   */
  async findHourlyRecords(
    siteId: string | null | undefined,
    fromStr?: string,
    toStr?: string,
  ) {
    const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const valid = (s?: string) =>
      s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;

    let from = valid(fromStr) ?? kstToday;
    let to = valid(toStr) ?? from;
    if (from > to) [from, to] = [to, from]; // 시작이 종료보다 늦으면 교환

    const MAX_DAYS = 92;
    const startMs = new Date(`${from}T00:00:00+09:00`).getTime();
    let endMs = new Date(`${to}T00:00:00+09:00`).getTime() + 24 * 3600_000;
    if ((endMs - startMs) / 86400_000 > MAX_DAYS) {
      endMs = startMs + MAX_DAYS * 86400_000;
      to = new Date(endMs - 24 * 3600_000 + 9 * 3600_000)
        .toISOString()
        .slice(0, 10);
    }

    const records = await this.prisma.heatHourlyRecord.findMany({
      where: {
        // siteId NULL 호환 (기존 데이터 보호 패턴 — 함정 #11)
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
        recordedAt: { gte: new Date(startMs), lt: new Date(endMs) },
      },
      orderBy: { recordedAt: 'asc' },
    });
    // date: from 은 단일일 하위호환용
    return { from, to, date: from, records };
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

  // ────────────────────────────────────────────────────────────
  // #39 월간 폭염 노출 리포트
  // ────────────────────────────────────────────────────────────

  /** 'YYYY-MM'(KST) → [start, end) UTC 범위. 형식 오류/미지정 시 KST 이번 달 */
  private resolveMonthRange(monthStr?: string): { ym: string; start: Date; end: Date } {
    const kstNow = new Date(Date.now() + 9 * 3600_000);
    const ym =
      monthStr && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)
        ? monthStr
        : kstNow.toISOString().slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const start = new Date(`${ym}-01T00:00:00+09:00`);
    const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const end = new Date(`${nextYm}-01T00:00:00+09:00`);
    return { ym, start, end };
  }

  /**
   * 작업의 "실제 작업 구간" 목록 (ms) — [startedAt, endedAt|now] 에서 중간마감 구간 제외
   * net-work-minutes.ts calcNetWorkMinutes 의 1)~2) 단계와 동일 규칙:
   *   - notes JSON { pauseHistory: [{pausedAt, resumedAt}] }
   *   - resumedAt 없으면 종료 시각(진행 중이면 now)까지 정지로 간주
   *   - [start, end] 로 클리핑 → 시작순 정렬 → 겹침 병합 → 여집합
   * (parsePauseIntervals 가 export 되지 않아 규칙만 동일하게 이식)
   */
  private activeSegmentsOf(
    startedAt: Date,
    endedAt: Date | null,
    notes: string | null,
  ): Array<[number, number]> {
    const start = startedAt.getTime();
    const end = endedAt ? endedAt.getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

    const pauses: Array<[number, number]> = [];
    if (notes) {
      try {
        const parsed = JSON.parse(notes);
        if (Array.isArray(parsed?.pauseHistory)) {
          for (const entry of parsed.pauseHistory) {
            const pAt = entry?.pausedAt ? new Date(entry.pausedAt).getTime() : 0;
            const rAt = entry?.resumedAt ? new Date(entry.resumedAt).getTime() : end;
            if (pAt > 0 && Number.isFinite(rAt) && rAt > pAt) {
              const p = Math.max(pAt, start);
              const r = Math.min(rAt, end);
              if (r > p) pauses.push([p, r]);
            }
          }
        }
      } catch {
        /* notes 가 JSON 이 아니면 중간마감 없음으로 처리 */
      }
    }
    pauses.sort((a, b) => a[0] - b[0]);

    const merged: Array<[number, number]> = [];
    for (const iv of pauses) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }

    const segments: Array<[number, number]> = [];
    let cursor = start;
    for (const [p, r] of merged) {
      if (p > cursor) segments.push([cursor, p]);
      cursor = Math.max(cursor, r);
    }
    if (end > cursor) segments.push([cursor, end]);
    return segments;
  }

  /**
   * 월간 폭염 노출 리포트 (#39, 관리자 웹 — KST 월 단위)
   *
   * HeatHourlyRecord(시간별 KOSHA 단계) × 작업 구간을 앱 레벨에서 교차해
   * 작업자별 "단계별 순작업(노출) 분"을 계산한다.
   *  - 작업 구간: startedAt ~ endedAt(진행 중이면 now) − 중간마감(pauseHistory) − 휴게시간 겹침
   *    (net-work-minutes.ts calcNetWorkMinutes 와 동일 규칙, 시간 단위로 잘라 단계에 귀속)
   *  - 참여자 귀속: startedByWorker ∪ WorkAssignment(STARTER/PARTICIPANT) — 시작자만 보면 참여자 누락
   *    (동시작업 시간 비례 분배 없음 — 노출은 사람 단위이므로 각자 전체 구간 귀속)
   *  - siteId 격리: WorkItem 에 siteId 없음 → startedByWorker.siteId OR NULL (함정 #11 보존)
   *  - 기록 없는 시간대는 'unknown' 으로 별도 집계 (정상으로 간주 금지)
   *  - 같은 시각에 기록이 둘 이상(사업장 기록 + NULL 레거시, 또는 MASTER 전체 조회)이면 높은 단계 우선
   *  - VOID 작업 제외, MASTER 역할 작업자 제외 (admin/workers 규칙)
   *  - 알림: HeatCheckAlert reportedAt 기준 해당 월, 작업자별 alertCount 귀속
   */
  async findMonthlyExposure(siteId: string | null | undefined, monthStr?: string) {
    const { ym, start, end } = this.resolveMonthRange(monthStr);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const HOUR_MS = 3600_000;
    const siteWhere = siteId ? { OR: [{ siteId }, { siteId: null }] } : {};

    const [hourRows, alertRows, items] = await Promise.all([
      this.prisma.heatHourlyRecord.findMany({
        where: { ...siteWhere, recordedAt: { gte: start, lt: end } },
        select: { siteId: true, recordedAt: true, level: true, wbgt: true },
      }),
      this.prisma.heatCheckAlert.findMany({
        where: { ...siteWhere, reportedAt: { gte: start, lt: end } },
        orderBy: { reportedAt: 'desc' },
        select: {
          id: true,
          workerId: true,
          workerName: true,
          result: true,
          symptoms: true,
          wbgt: true,
          slot: true,
          reportedAt: true,
        },
      }),
      this.prisma.workItem.findMany({
        where: {
          // ★ siteId 격리: 해당 사업장 작업자 + siteId 미배정(레거시) 작업자
          ...(siteId ? { startedByWorker: { OR: [{ siteId }, { siteId: null }] } } : {}),
          status: { not: 'VOID' },
          // 월 범위와 겹치는 작업: 시작 < 월말 AND (미종료 OR 종료 >= 월초)
          startedAt: { lt: end },
          OR: [{ endedAt: null }, { endedAt: { gte: start } }],
        },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          notes: true,
          startedByWorker: {
            select: { id: true, name: true, employeeCode: true, role: true, siteId: true },
          },
          assignments: {
            select: {
              worker: { select: { id: true, name: true, employeeCode: true, role: true } },
            },
          },
        },
      }),
    ]);

    // 1) 시각(정시 ms) → 단계. 중복 시 높은 단계 우선 (보수적)
    const hourLevel = new Map<number, HeatLevel>();
    for (const r of hourRows) {
      const key = Math.floor(r.recordedAt.getTime() / HOUR_MS) * HOUR_MS;
      const lv: HeatLevel =
        r.level in HEAT_LEVELS ? (r.level as HeatLevel) : heatLevelOf(Number(r.wbgt));
      const cur = hourLevel.get(key);
      if (!cur || HEAT_LEVELS[lv].rank > HEAT_LEVELS[cur].rank) hourLevel.set(key, lv);
    }

    // 2) 휴게시간 설정 (사업장별, 1회 조회)
    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...items.map((i) => i.startedByWorker?.siteId),
    ]);

    // 3) 작업자별 누적 (ms)
    interface Acc {
      workerId: string;
      name: string;
      employeeCode: string;
      ms: Record<ExposureKey, number>;
      alertCount: number;
    }
    const workers = new Map<string, Acc>();
    const emptyMs = (): Record<ExposureKey, number> => ({
      normal: 0,
      attention: 0,
      caution: 0,
      warning: 0,
      danger: 0,
      unknown: 0,
    });
    const ensure = (w: ExposureWorkerRef): Acc => {
      let acc = workers.get(w.id);
      if (!acc) {
        acc = {
          workerId: w.id,
          name: w.name,
          employeeCode: w.employeeCode,
          ms: emptyMs(),
          alertCount: 0,
        };
        workers.set(w.id, acc);
      }
      return acc;
    };
    const isMaster = (role?: string | null) => String(role ?? '').toUpperCase() === 'MASTER';

    for (const item of items) {
      // 참여자 = 시작자 ∪ 배정(STARTER/PARTICIPANT) — dedup, MASTER 제외
      const people = new Map<string, ExposureWorkerRef>();
      if (item.startedByWorker && !isMaster(item.startedByWorker.role)) {
        people.set(item.startedByWorker.id, item.startedByWorker);
      }
      for (const a of item.assignments) {
        if (a.worker && !isMaster(a.worker.role)) people.set(a.worker.id, a.worker);
      }
      if (people.size === 0) continue;

      const breakCfg = breaks.forSite(item.startedByWorker?.siteId);
      const bucket = emptyMs();
      let any = false;
      for (const [s0, e0] of this.activeSegmentsOf(item.startedAt, item.endedAt, item.notes)) {
        // 월 범위로 클리핑
        const s = Math.max(s0, startMs);
        const e = Math.min(e0, endMs);
        if (e <= s) continue;
        // 정시 단위로 잘라 각 시간대의 단계에 귀속 (휴게 겹침은 조각별 차감)
        let h = Math.floor(s / HOUR_MS) * HOUR_MS;
        while (h < e) {
          const ss = Math.max(h, s);
          const ee = Math.min(h + HOUR_MS, e);
          const ms = ee - ss - breakOverlapMs(ss, ee, breakCfg);
          if (ms > 0) {
            const lv: ExposureKey = hourLevel.get(h) ?? 'unknown';
            bucket[lv] += ms;
            any = true;
          }
          h += HOUR_MS;
        }
      }
      if (!any) continue;
      for (const p of people.values()) {
        const acc = ensure(p);
        for (const k of EXPOSURE_KEYS) acc.ms[k] += bucket[k];
      }
    }

    // 4) 알림 귀속 — 이번 달 작업 기록이 없는 작업자도 alertCount 를 잃지 않도록 행 생성
    const missingIds = Array.from(
      new Set(alertRows.map((a) => a.workerId).filter((id) => !workers.has(id))),
    );
    if (missingIds.length > 0) {
      const found = await this.prisma.worker.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true, employeeCode: true, role: true },
      });
      const byId = new Map(found.map((w) => [w.id, w]));
      for (const id of missingIds) {
        const w = byId.get(id);
        if (w) {
          if (!isMaster(w.role)) ensure(w);
        } else {
          // 삭제된 작업자 — 알림에 남은 이름으로 표시
          const alert = alertRows.find((a) => a.workerId === id);
          ensure({ id, name: alert?.workerName ?? '(삭제된 작업자)', employeeCode: '' });
        }
      }
    }
    for (const a of alertRows) {
      const acc = workers.get(a.workerId);
      if (acc) acc.alertCount += 1;
    }

    // 5) 응답 (분 단위 반올림, 위험→경고→주의→관심 많은 순, 이름순)
    const toMin = (ms: number) => Math.max(0, Math.round(ms / 60_000));
    const workersOut = Array.from(workers.values())
      .map((w) => {
        const totalMs = EXPOSURE_KEYS.reduce((sum, k) => sum + w.ms[k], 0);
        return {
          workerId: w.workerId,
          name: w.name,
          employeeCode: w.employeeCode,
          minutesByLevel: {
            attention: toMin(w.ms.attention),
            caution: toMin(w.ms.caution),
            warning: toMin(w.ms.warning),
            danger: toMin(w.ms.danger),
          },
          normalMinutes: toMin(w.ms.normal),
          unknownMinutes: toMin(w.ms.unknown),
          totalMinutes: toMin(totalMs),
          alertCount: w.alertCount,
        };
      })
      .sort(
        (a, b) =>
          b.minutesByLevel.danger - a.minutesByLevel.danger ||
          b.minutesByLevel.warning - a.minutesByLevel.warning ||
          b.minutesByLevel.caution - a.minutesByLevel.caution ||
          b.minutesByLevel.attention - a.minutesByLevel.attention ||
          b.alertCount - a.alertCount ||
          a.name.localeCompare(b.name, 'ko'),
      );

    const alertsOut = alertRows.map((a) => ({
      id: a.id,
      reportedAt: a.reportedAt,
      workerId: a.workerId,
      workerName: a.workerName,
      result: a.result,
      symptoms: a.symptoms,
      symptomsKo: a.symptoms.map((s) => this.symptomLabel(s)).join(', '),
      wbgt: Number(a.wbgt),
      slot: a.slot,
    }));

    const sumOf = (pick: (w: (typeof workersOut)[number]) => number) =>
      workersOut.reduce((sum, w) => sum + pick(w), 0);

    return {
      month: ym,
      summary: {
        recordedHours: hourLevel.size,
        workItemCount: items.length,
        workerCount: workersOut.length,
        alertCount: alertsOut.length,
        cautionPlusMinutes: sumOf(
          (w) => w.minutesByLevel.caution + w.minutesByLevel.warning + w.minutesByLevel.danger,
        ),
        dangerWorkerCount: workersOut.filter((w) => w.minutesByLevel.danger > 0).length,
        unknownMinutes: sumOf((w) => w.unknownMinutes),
      },
      workers: workersOut,
      alerts: alertsOut,
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
