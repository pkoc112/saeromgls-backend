import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 인보이스 (수동 청구) 서비스
 * - 매월 1일 04:00 KST 자동 생성 (활성 구독 사이트 대상)
 * - 상태 전이: DRAFT → ISSUED → PAID / OVERDUE / CANCELLED
 * - 입금 확인 시 구독 currentPeriodEnd +1개월
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 매월 자동 청구서 생성 — cron에서 호출
   * - 모든 ACTIVE/TRIAL 구독에 대해 이번 달 인보이스 생성
   * - 이미 생성된 사이트(같은 invoice_number)는 skip
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
    const subs = await this.prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      include: {
        plan: true,
        site: { select: { id: true, name: true, code: true } },
      },
    });

    const stats = {
      monthLabel: month,
      generated: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const sub of subs) {
      const invoiceNumber = `${month.replace('-', '')}-${sub.site.code}-001`;
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

        await this.prisma.invoice.create({
          data: {
            siteId: sub.siteId,
            subscriptionId: sub.id,
            invoiceNumber,
            status: 'DRAFT',
            amount,
            taxAmount: tax,
            totalAmount: total,
            periodStart,
            periodEnd,
            dueDate,
          },
        });
        stats.generated++;
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
   * issuedAt 기록
   */
  async issue(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    if (inv.status !== 'DRAFT') {
      throw new BadRequestException(`이미 ${inv.status} 상태입니다`);
    }
    return this.prisma.invoice.update({
      where: { id },
      data: { status: 'ISSUED', issuedAt: new Date() },
    });
  }

  /**
   * 입금 확인 (→ PAID + 구독 currentPeriodEnd +1개월)
   */
  async markPaid(id: string, dto: { paymentMethod?: string; paymentNote?: string }) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { subscription: true },
    });
    if (!inv) throw new NotFoundException('인보이스를 찾을 수 없습니다');
    if (inv.status === 'PAID') {
      throw new BadRequestException('이미 결제 완료된 인보이스입니다');
    }
    if (inv.status === 'CANCELLED') {
      throw new BadRequestException('취소된 인보이스는 결제 처리할 수 없습니다');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paymentMethod: dto.paymentMethod || 'BANK_TRANSFER',
          paymentNote: dto.paymentNote || null,
        },
      });

      // 구독 currentPeriodEnd +1개월 연장
      const sub = inv.subscription;
      const newEnd = new Date(sub.currentPeriodEnd);
      newEnd.setMonth(newEnd.getMonth() + (sub.billingCycle === 'YEARLY' ? 12 : 1));

      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          currentPeriodEnd: newEnd,
        },
      });

      return updated;
    });
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
   */
  async checkOverdue() {
    const now = new Date();
    const result = await this.prisma.invoice.updateMany({
      where: {
        status: 'ISSUED',
        dueDate: { lt: now },
      },
      data: { status: 'OVERDUE' },
    });
    this.logger.log(`Overdue invoices marked: ${result.count}`);
    return { markedOverdue: result.count };
  }
}
