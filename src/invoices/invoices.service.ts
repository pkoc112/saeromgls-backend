import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../common/notifications/notifications.service';

/** 인보이스 메일 종류: 발행(청구서) / 연체 안내 / 입금 확인 */
type InvoiceMailKind = 'issued' | 'overdue' | 'paid';

/** 메일 본문 생성에 필요한 최소 정보 (Prisma 결과에서 평탄화) */
interface InvoiceMailInput {
  id: string;
  siteId: string;
  invoiceNumber: string;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  paidAt?: Date | null;
  paymentMethod?: string | null;
  siteName: string;
  planName: string;
  /** 입금 확인 시 연장된 이용기간 종료일 */
  nextPeriodEnd?: Date | null;
}

/** 메일 발송 결과 (호출자는 카운트만 집계, 절대 throw 하지 않음) */
type InvoiceMailOutcome = 'sent' | 'skipped' | 'failed';

/**
 * 인보이스 (수동 청구) 서비스
 * - 매월 1일 04:00 KST 자동 생성 (활성 구독 사이트 대상)
 * - 상태 전이: DRAFT → ISSUED → PAID / OVERDUE / CANCELLED
 * - 입금 확인 시 구독 currentPeriodEnd +1개월
 * - #48 이메일: 발행(청구서) / 연체 안내 / 입금 확인 — NotificationsService 경유.
 *   메일 실패는 항상 삼키고 warn 만 남김 (생성·상태 전이·입금 처리를 차단하지 않음)
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 매월 자동 청구서 생성 — cron에서 호출
   * - 모든 ACTIVE/TRIAL 구독에 대해 이번 달 인보이스 생성
   * - 이미 생성된 사이트(같은 invoice_number)는 skip
   * - 생성 즉시 ISSUED 이므로 청구서 메일도 여기서 발송 (mailed/mailSkipped 집계)
   */
  async generateMonthlyInvoices(targetMonth?: string) {
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    // 이번 달 ("2026-05")
    const month =
      targetMonth ||
      `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}`;

    const periodStart = new Date(`${month}-01T00:00:00+09:00`);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setMilliseconds(-1); // 말일 23:59:59.999

    const dueDate = new Date(periodStart);
    dueDate.setDate(15); // 매월 15일

    // 활성 구독 조회 (TRIAL은 무료, ACTIVE만 청구)
    // ★ YEARLY 구독은 월간 cron에서 제외 — 연요금이 매달(12배) 청구되는 버그 방지.
    //   연 구독 갱신은 입금확인(markPaid) 시 currentPeriodEnd +12개월으로 처리됨.
    const subs = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE', billingCycle: 'MONTHLY' },
      include: {
        plan: true,
        site: { select: { id: true, name: true, code: true } },
      },
    });

    const stats = {
      monthLabel: month,
      generated: 0,
      skipped: 0,
      /** 청구서 메일 발송 성공 건수 */
      mailed: 0,
      /** 청구서 메일 미발송(수신자 없음/메일 미설정/실패) 건수 — 생성 자체는 성공 */
      mailSkipped: 0,
      errors: [] as string[],
    };

    for (const sub of subs) {
      // 구독 id 일부를 suffix로 — 같은 사이트 다중 ACTIVE 구독 시 번호 충돌(무청구) 방지
      const invoiceNumber = `${month.replace('-', '')}-${sub.site.code}-${sub.id.slice(0, 6)}`;
      try {
        const existing = await this.prisma.invoice.findUnique({
          where: { invoiceNumber },
        });
        if (existing) {
          stats.skipped++;
          continue;
        }
        const amount =
          sub.billingCycle === 'YEARLY' ? sub.plan.priceYearly : sub.plan.priceMonthly;
        const tax = Math.floor(amount * 0.1);
        const total = amount + tax;

        const created = await this.prisma.invoice.create({
          data: {
            siteId: sub.siteId,
            subscriptionId: sub.id,
            invoiceNumber,
            // 자동 발행(ISSUED)으로 생성 — checkOverdue(ISSUED&dueDate<now)가 동작하도록
            // (DRAFT로 두면 수동 발행 전까지 OVERDUE 전이가 영원히 안 됨)
            status: 'ISSUED',
            issuedAt: new Date(),
            amount,
            taxAmount: tax,
            totalAmount: total,
            periodStart,
            periodEnd,
            dueDate,
          },
        });
        stats.generated++;

        // 청구서 메일 — 실패해도 생성 결과에는 영향 없음
        const outcome = await this.notifyInvoice('issued', {
          ...created,
          siteName: sub.site.name,
          planName: sub.plan.name,
        });
        if (outcome === 'sent') stats.mailed++;
        else stats.mailSkipped++;
      } catch (err) {
        const msg = `${sub.site.name}: ${err}`;
        this.logger.warn(`Invoice generation failed — ${msg}`);
        stats.errors.push(msg);
      }
    }

    this.logger.log(`Monthly invoices generated: ${JSON.stringify(stats)}`);
    return stats;
  }

  async findAll(siteId?: string | null, status?: string) {
    const where: { siteId?: string; status?: string } = {};
    if (siteId) where.siteId = siteId;
    if (status) where.status = status;

    return this.prisma.invoice.findMany({
      where,
      include: {
        site: { select: { name: true, code: true } },
        subscription: { include: { plan: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(id: string, siteId?: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        site: true,
        subscription: { include: { plan: true } },
      },
    });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    // 사이트 소유권 검증 — siteId가 지정된(비-MASTER) 경우 타 테넌트 청구서 접근 차단(IDOR 방어).
    // 존재 여부 노출 방지를 위해 NotFound로 통일.
    if (siteId && inv.siteId !== siteId) {
      throw new NotFoundException('인보이스를 찾을 수 없습니다');
    }
    return inv;
  }

  /**
   * 인보이스 발행 (DRAFT → ISSUED)
   * issuedAt 기록 + 청구서 메일 발송 (메일 실패는 발행을 막지 않음)
   */
  async issue(id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
        subscription: { include: { plan: { select: { name: true } } } },
      },
    });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    if (inv.status !== 'DRAFT') {
      throw new BadRequestException(`이미 ${inv.status} 상태입니다`);
    }
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: 'ISSUED', issuedAt: new Date() },
    });

    await this.notifyInvoice('issued', {
      ...updated,
      siteName: inv.site.name,
      planName: inv.subscription.plan.name,
    });

    return updated;
  }

  /**
   * 입금 확인 (→ PAID + 구독 currentPeriodEnd +1개월)
   * 트랜잭션 성공 후 입금 확인 메일 발송 (메일 실패는 입금 처리를 막지 않음)
   */
  async markPaid(id: string, dto: { paymentMethod?: string; paymentNote?: string }) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
        subscription: { include: { plan: { select: { name: true } } } },
      },
    });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    if (inv.status === 'PAID') {
      throw new BadRequestException('이미 결제 완료된 인보이스입니다');
    }
    if (inv.status === 'CANCELLED') {
      throw new BadRequestException('취소된 인보이스는 결제 처리할 수 없습니다');
    }

    // 구독 currentPeriodEnd +1개월(연 구독 +12개월) 연장 — 순수 계산은 트랜잭션 밖에서
    const sub = inv.subscription;
    const newEnd = new Date(sub.currentPeriodEnd);
    newEnd.setMonth(newEnd.getMonth() + (sub.billingCycle === 'YEARLY' ? 12 : 1));

    const updated = await this.prisma.$transaction(async (tx) => {
      const paid = await tx.invoice.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paymentMethod: dto.paymentMethod || 'BANK_TRANSFER',
          paymentNote: dto.paymentNote || null,
        },
      });

      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          currentPeriodEnd: newEnd,
        },
      });

      return paid;
    });

    // 트랜잭션 커밋 이후에만 발송 — 롤백된 입금에 확인 메일이 나가지 않도록
    await this.notifyInvoice('paid', {
      ...updated,
      siteName: inv.site.name,
      planName: sub.plan.name,
      nextPeriodEnd: newEnd,
    });

    return updated;
  }

  async cancel(id: string, reason?: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    if (inv.status === 'PAID') {
      throw new BadRequestException('결제 완료된 인보이스는 취소할 수 없습니다');
    }
    return this.prisma.invoice.update({
      where: { id },
      data: { status: 'CANCELLED', paymentNote: reason || '관리자 취소' },
    });
  }

  /**
   * 매일 자동으로 OVERDUE 체크 (cron) — 기한 지난 ISSUED 인보이스
   * - 건별 update(status:'ISSUED' 조건) → 전이된 건에만 연체 안내 메일 1회
   *   (cron 재시도/동시 실행 시 중복 발송 방지: 이미 OVERDUE 면 count=0 → skip)
   * - 반환 필드 markedOverdue 는 cron 로그가 읽으므로 유지
   */
  async checkOverdue() {
    const now = new Date();
    const candidates = await this.prisma.invoice.findMany({
      where: {
        status: 'ISSUED',
        dueDate: { lt: now },
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
        subscription: { include: { plan: { select: { name: true } } } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const stats = {
      markedOverdue: 0,
      /** 연체 안내 메일 발송 성공 */
      notified: 0,
      /** 이미 전이됨 / 수신자 없음 / 메일 미설정 / 발송 실패 (전이 자체는 완료) */
      skipped: 0,
      errors: [] as string[],
    };

    for (const inv of candidates) {
      try {
        const r = await this.prisma.invoice.updateMany({
          where: { id: inv.id, status: 'ISSUED' },
          data: { status: 'OVERDUE' },
        });
        if (r.count === 0) {
          // 동시 실행/재시도로 이미 OVERDUE 처리됨 — 메일 중복 방지
          stats.skipped++;
          continue;
        }
        stats.markedOverdue++;

        const outcome = await this.notifyInvoice('overdue', {
          ...inv,
          siteName: inv.site.name,
          planName: inv.subscription.plan.name,
        });
        if (outcome === 'sent') stats.notified++;
        else stats.skipped++;
      } catch (err) {
        const msg = `${inv.site.name} ${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn(`Overdue transition failed — ${msg}`);
        stats.errors.push(msg);
      }
    }

    this.logger.log(
      `Overdue invoices marked: ${stats.markedOverdue} (notified=${stats.notified}, skipped=${stats.skipped}, errors=${stats.errors.length})`,
    );
    return stats;
  }

  // ──────────────────────────────────────────────
  // #48 인보이스 메일
  // ──────────────────────────────────────────────

  /**
   * 인보이스 메일 발송 — 절대 throw 하지 않음
   * 수신자: TenantSettings.settings.billingEmail(있으면) → NotificationsService.resolveRecipients(siteId,'subscription')
   * (MASTER 폴백 없음 — 고객 청구 메일에 운영자 메일이 섞이지 않도록, 알림 허브 설계와 동일)
   */
  private async notifyInvoice(
    kind: InvoiceMailKind,
    inv: InvoiceMailInput,
  ): Promise<InvoiceMailOutcome> {
    const label = `${inv.siteName} ${inv.invoiceNumber} [${kind}]`;
    try {
      const recipients = await this.resolveInvoiceRecipients(inv.siteId);
      if (recipients.length === 0) {
        this.logger.warn(`인보이스 메일 스킵(수신자 없음): ${label}`);
        return 'skipped';
      }

      const mail = this.buildInvoiceMail(kind, inv);
      const sendResult = await this.notifications.sendMail({
        to: recipients,
        subject: mail.subject,
        html: mail.html,
      });

      if (sendResult.ok) {
        this.logger.log(`인보이스 메일 발송: ${label} → ${recipients.length}명`);
        return 'sent';
      }
      if (sendResult.error === 'no-api-key') {
        this.logger.warn(`인보이스 메일 미발송(메일 미설정): ${label}`);
        return 'skipped';
      }
      this.logger.warn(`인보이스 메일 발송 실패: ${label}: ${sendResult.error || 'unknown'}`);
      return 'failed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`인보이스 메일 처리 예외(무시): ${label}: ${msg}`);
      return 'failed';
    }
  }

  /**
   * 청구 메일 수신자 결정
   *  1) TenantSettings.settings.billingEmail — 문자열(콤마 허용) 또는 배열
   *     (Site 모델에 billingEmail 컬럼이 없어 센터 설정 JSON 키로 대체. 컬럼 추가 시 여기만 교체)
   *  2) 알림 허브 'subscription' 이벤트 수신자 (센터 알림 설정 → alertEmail → 인증된 관리자)
   */
  private async resolveInvoiceRecipients(siteId: string): Promise<string[]> {
    try {
      const ts = await this.prisma.tenantSettings.findFirst({
        where: { siteId },
        select: { settings: true },
      });
      if (ts?.settings) {
        const parsed = JSON.parse(ts.settings) as { billingEmail?: unknown };
        const billing = this.toEmailList(parsed?.billingEmail);
        if (billing.length > 0) return billing;
      }
    } catch (err) {
      this.logger.warn(`billingEmail 설정 조회 실패(site ${siteId}) — 알림 허브 폴백: ${err}`);
    }
    return this.notifications.resolveRecipients(siteId, 'subscription');
  }

  /** 문자열/배열 → 이메일 후보 배열 (최종 trim·소문자·중복 제거는 sendMail 이 수행) */
  private toEmailList(input: unknown): string[] {
    const raw: string[] = [];
    if (Array.isArray(input)) {
      for (const v of input) if (typeof v === 'string') raw.push(...v.split(/[,;\s]+/));
    } else if (typeof input === 'string') {
      raw.push(...input.split(/[,;\s]+/));
    }
    return raw.map((e) => e.trim()).filter((e) => e.includes('@'));
  }

  /**
   * 메일 제목/본문 생성
   * - 제목: '[새롬GLS][센터명] N월 이용료 청구서' (연체: '... N월 이용료 미납 안내', 입금: '... N월 이용료 입금 확인')
   * - 입금계좌(BILLING_BANK_ACCOUNT)·상호(BILLING_COMPANY_NAME)는 환경변수 미설정 시 해당 줄 생략
   */
  private buildInvoiceMail(
    kind: InvoiceMailKind,
    inv: InvoiceMailInput,
  ): { subject: string; html: string } {
    const siteName = inv.siteName;
    const safeSite = this.escapeHtml(siteName);
    const planName = this.escapeHtml(inv.planName || '-');
    const invoiceNo = this.escapeHtml(inv.invoiceNumber);
    const monthNo = this.kstMonth(inv.periodStart);
    const amount = Number(inv.amount);
    const tax = Number(inv.taxAmount);
    const total = Number(inv.totalAmount);
    const won = (n: number) => `${Number(n).toLocaleString('ko-KR')}원`;
    const period = `${this.formatKstDate(inv.periodStart)} ~ ${this.formatKstDate(inv.periodEnd)}`;
    const dueDateKo = `${this.formatKstDate(inv.dueDate)} (KST)`;

    const companyName = (process.env.BILLING_COMPANY_NAME || '').trim();
    const bankAccount = (process.env.BILLING_BANK_ACCOUNT || '').trim();
    const contactEmail = this.notifications.masterEmail();
    const invoicesUrl = `${process.env.WEB_BASE_URL || 'https://sae-work.com'}/invoices`;

    let subject: string;
    let title: string;
    let accent: string;
    let bg: string;
    let intro: string;
    let rows: Array<[string, string]>;
    let notice: string;

    if (kind === 'issued') {
      subject = `[새롬GLS][${siteName}] ${monthNo}월 이용료 청구서`;
      title = `${monthNo}월 이용료 청구서`;
      accent = '#2C6FB0';
      bg = '#EFF6FF';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 ${monthNo}월 이용료 청구서를 보내드립니다.`;
      rows = [
        ['사업장', safeSite],
        ['플랜', planName],
        ['청구서 번호', invoiceNo],
        ['이용 기간', period],
        ['공급가액', won(amount)],
        ['부가세 (10%)', won(tax)],
        ['청구 금액 (합계)', `<b>${won(total)}</b>`],
        ['납부 기한', dueDateKo],
      ];
      notice =
        '납부 기한까지 아래 계좌로 입금해 주시기 바랍니다. ' +
        '입금 확인 후 이용기간이 자동 연장되며, 세금계산서가 필요하시면 문의처로 알려주세요.';
    } else if (kind === 'overdue') {
      const overdueDays = Math.max(
        1,
        Math.floor((Date.now() - new Date(inv.dueDate).getTime()) / (24 * 60 * 60 * 1000)),
      );
      subject = `[새롬GLS][${siteName}] ${monthNo}월 이용료 미납 안내 (납기 경과)`;
      title = `${monthNo}월 이용료 미납 안내`;
      accent = '#DC2626';
      bg = '#FEF2F2';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 ${monthNo}월 이용료 납부 기한이 <b>${overdueDays}일</b> 경과했습니다.`;
      rows = [
        ['사업장', safeSite],
        ['플랜', planName],
        ['청구서 번호', invoiceNo],
        ['이용 기간', period],
        ['미납 금액 (VAT 포함)', `<b>${won(total)}</b>`],
        ['납부 기한', `${dueDateKo} — ${overdueDays}일 경과`],
      ];
      notice =
        '미납 상태가 지속되면 이용기간 종료 후 서비스 이용이 제한될 수 있습니다. ' +
        '이미 입금하셨다면 문의처로 입금일·입금자명을 알려주시면 즉시 확인해 드립니다.';
    } else {
      subject = `[새롬GLS][${siteName}] ${monthNo}월 이용료 입금 확인`;
      title = `${monthNo}월 이용료 입금 확인`;
      accent = '#16A34A';
      bg = '#F0FDF4';
      intro = `${safeSite} 사업장의 <b>${planName}</b> 플랜 ${monthNo}월 이용료 입금이 확인되었습니다. 감사합니다.`;
      rows = [
        ['사업장', safeSite],
        ['플랜', planName],
        ['청구서 번호', invoiceNo],
        ['이용 기간', period],
        ['입금 금액 (VAT 포함)', `<b>${won(total)}</b>`],
        ['입금 확인일', inv.paidAt ? `${this.formatKstDate(inv.paidAt)} (KST)` : '-'],
        ['결제 수단', this.paymentMethodLabel(inv.paymentMethod)],
      ];
      if (inv.nextPeriodEnd) {
        rows.push(['연장된 이용기간 종료일', `${this.formatKstDate(inv.nextPeriodEnd)} (KST)`]);
      }
      notice =
        '입금 확인과 함께 구독 이용기간이 연장되었습니다. ' +
        '세금계산서가 필요하시면 문의처로 알려주세요.';
    }

    // 상호·입금계좌 — 청구/연체 메일에만, 환경변수 미설정 시 해당 줄 생략
    if (kind !== 'paid') {
      if (companyName) rows.push(['상호 (공급자)', this.escapeHtml(companyName)]);
      if (bankAccount) rows.push(['입금 계좌', this.escapeHtml(bankAccount)]);
    }

    const infoTable = rows
      .map(
        ([k, v]) =>
          `<tr>
            <td style="padding:8px 12px;border:1px solid #E2E8F0;background:#F8FAFC;color:#475569;font-size:13px;white-space:nowrap;">${k}</td>
            <td style="padding:8px 12px;border:1px solid #E2E8F0;color:#0F172A;font-size:13px;">${v}</td>
          </tr>`,
      )
      .join('');

    const html = `
      <div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <div style="background:${bg};border-left:4px solid ${accent};padding:16px;border-radius:8px;margin-bottom:20px;">
          <h2 style="color:${accent};margin:0 0 6px;font-size:18px;">${title}</h2>
          <p style="color:#334155;margin:0;font-size:14px;line-height:1.6;">${intro}</p>
        </div>
        <table style="border-collapse:collapse;width:100%;">${infoTable}</table>
        <p style="color:#475569;font-size:13px;line-height:1.7;margin:16px 0 0;">${notice}</p>
        <div style="margin:24px 0 0;padding:14px 16px;background:#F8FAFC;border-radius:8px;">
          <p style="color:#0F172A;font-size:13px;margin:0 0 6px;"><b>문의 · 결제 안내</b></p>
          <p style="color:#475569;font-size:13px;line-height:1.7;margin:0;">
            이메일: <a href="mailto:${contactEmail}" style="color:#2C6FB0;">${contactEmail}</a><br>
            인보이스 조회: <a href="${invoicesUrl}" style="color:#2C6FB0;">${invoicesUrl}</a>
          </p>
        </div>
        <p style="color:#CBD5E1;font-size:11px;margin-top:24px;text-align:center;">
          본 메일은 새롬 GLS 작업현황 공유 시스템에서 자동 발송되었습니다.
        </p>
      </div>
    `;

    return { subject, html };
  }

  private paymentMethodLabel(method?: string | null): string {
    switch ((method || 'BANK_TRANSFER').toUpperCase()) {
      case 'BANK_TRANSFER':
        return '계좌이체';
      case 'CARD':
        return '카드';
      case 'CASH':
        return '현금';
      default:
        return this.escapeHtml(method || '-');
    }
  }

  /** KST 기준 월(1~12) */
  private kstMonth(date: Date): number {
    const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
    return kst.getUTCMonth() + 1;
  }

  /** KST 기준 'YYYY년 M월 D일' */
  private formatKstDate(date: Date): string {
    const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
    return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
  }

  private escapeHtml(value: string): string {
    return String(value ?? '').replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
    );
  }
}
