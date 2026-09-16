import { BadRequestException, Logger } from '@nestjs/common';
import { InvoicesService, computeInvoicePeriod } from './invoices.service';

/** KST 'YYYY-MM-DD HH:mm:ss.SSS' — 호스트 타임존 무관하게 UTC getter + 9h 로 렌더 (서비스의 formatKstDate 와 동일 방식) */
const kst = (d: Date) => {
  const t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}`;
};

describe('computeInvoicePeriod (KST, host-timezone independent)', () => {
  it.each([
    // month, periodStart(UTC), periodEnd(UTC), dueDate(UTC)
    ['2026-09', '2026-08-31T15:00:00.000Z', '2026-09-30T14:59:59.999Z', '2026-09-14T15:00:00.000Z'],
    ['2026-12', '2026-11-30T15:00:00.000Z', '2026-12-31T14:59:59.999Z', '2026-12-14T15:00:00.000Z'], // 연도 넘김
    ['2026-02', '2026-01-31T15:00:00.000Z', '2026-02-28T14:59:59.999Z', '2026-02-14T15:00:00.000Z'], // 평년 2월
  ])('%s → start/end/due in UTC', (month, start, end, due) => {
    const r = computeInvoicePeriod(month);
    expect(r.periodStart.toISOString()).toBe(start);
    expect(r.periodEnd.toISOString()).toBe(end);
    expect(r.dueDate.toISOString()).toBe(due);
  });

  it.each([
    ['2026-09', '2026-09-01 00:00:00.000', '2026-09-30 23:59:59.999', '2026-09-15 00:00:00.000'],
    ['2026-12', '2026-12-01 00:00:00.000', '2026-12-31 23:59:59.999', '2026-12-15 00:00:00.000'],
    ['2026-02', '2026-02-01 00:00:00.000', '2026-02-28 23:59:59.999', '2026-02-15 00:00:00.000'],
  ])('%s → 1일 00:00 / 말일 23:59:59.999 / 15일 00:00 in KST', (month, start, end, due) => {
    const r = computeInvoicePeriod(month);
    expect(kst(r.periodStart)).toBe(start);
    expect(kst(r.periodEnd)).toBe(end);
    expect(kst(r.dueDate)).toBe(due);
  });

  it('matches explicit +09:00 ISO references (no setMonth/setDate local-time drift)', () => {
    const r = computeInvoicePeriod('2026-09');
    expect(r.periodStart.getTime()).toBe(Date.parse('2026-09-01T00:00:00+09:00'));
    expect(r.periodEnd.getTime()).toBe(Date.parse('2026-10-01T00:00:00+09:00') - 1);
    expect(r.dueDate.getTime()).toBe(Date.parse('2026-09-15T00:00:00+09:00'));
    // 납기는 항상 기간 안에 있어야 함 (과거 버그: dueDate 가 전월 15일 → 발행 즉시 OVERDUE)
    expect(r.dueDate.getTime()).toBeGreaterThan(r.periodStart.getTime());
    expect(r.dueDate.getTime()).toBeLessThan(r.periodEnd.getTime());
  });

  it('handles leap-year February and year rollover end-to-end', () => {
    expect(computeInvoicePeriod('2028-02').periodEnd.toISOString()).toBe('2028-02-29T14:59:59.999Z');
    expect(kst(computeInvoicePeriod('2026-12').periodEnd)).toBe('2026-12-31 23:59:59.999');
    expect(computeInvoicePeriod('2027-01').periodStart.getTime()).toBe(computeInvoicePeriod('2026-12').periodEnd.getTime() + 1);
  });

  it.each(['2026-13', '2026-00', '2026-9', '202609', '2026/09', '', 'bad'])('rejects malformed month: %s', (month) => {
    expect(() => computeInvoicePeriod(month)).toThrow(BadRequestException);
  });
});

describe('generateMonthlyInvoices uses KST period/due dates', () => {
  let prisma: any;
  let mail: any;
  let service: InvoicesService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T19:00:00Z')); // 2026-09-01 04:00 KST (cron 시각) — UTC 날짜는 아직 8/31
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    prisma = {
      subscription: { findMany: jest.fn().mockResolvedValue([{
        id: 'sub-abcdef-1', siteId: 'site-a', status: 'ACTIVE', billingCycle: 'MONTHLY',
        plan: { name: 'Standard', priceMonthly: 100000, priceYearly: 1000000 },
        site: { id: 'site-a', name: '대구물류센터', code: 'DGU' },
      }]) },
      invoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => ({ id: 'inv-1', ...data })),
      },
      tenantSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    mail = {
      resolveRecipients: jest.fn().mockResolvedValue(['billing@example.com']),
      sendMail: jest.fn().mockResolvedValue({ ok: true }),
      masterEmail: jest.fn().mockReturnValue('master@example.com'),
    };
    service = new InvoicesService(prisma, mail);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('derives the month in KST and stores 9/1 00:00 ~ 9/30 23:59:59.999 with due 9/15 (KST)', async () => {
    const stats = await service.generateMonthlyInvoices();
    expect(stats.monthLabel).toBe('2026-09'); // UTC 로는 8월이지만 KST 기준 9월
    expect(stats.generated).toBe(1);

    const { data } = prisma.invoice.create.mock.calls[0][0];
    expect(data.periodStart.toISOString()).toBe('2026-08-31T15:00:00.000Z');
    expect(data.periodEnd.toISOString()).toBe('2026-09-30T14:59:59.999Z');
    expect(data.dueDate.toISOString()).toBe('2026-09-14T15:00:00.000Z');
    // 과거 버그 재발 방지: 발행 시각보다 납기가 뒤여야 함 (전월 15일이면 발행 즉시 OVERDUE)
    expect(data.dueDate.getTime()).toBeGreaterThan(data.issuedAt.getTime());
    expect(data.invoiceNumber).toBe('202609-DGU-sub-ab');
  });

  it('renders the issued mail with the correct KST period and due date', async () => {
    await service.generateMonthlyInvoices('2026-09');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const { subject, html } = mail.sendMail.mock.calls[0][0];
    expect(subject).toContain('9월 이용료 청구서');
    expect(html).toContain('2026년 9월 1일 ~ 2026년 9월 30일');
    expect(html).toContain('2026년 9월 15일 (KST)');
    expect(html).not.toContain('10월 1일');
    expect(html).not.toContain('8월 15일');
  });

  it('rejects a malformed manual month before touching the DB', async () => {
    await expect(service.generateMonthlyInvoices('2026-9')).rejects.toThrow(BadRequestException);
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
  });
});
