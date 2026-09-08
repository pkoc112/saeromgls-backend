import { WorkItemsService } from './work-items.service';
import { DashboardService } from '../dashboard/dashboard.service';

const date = (time: string) => new Date(`2026-09-08T${time}+09:00`);
const user = { sub: 'tablet', role: 'ADMIN', siteId: 'site-a' } as any;

describe('Mobile work time and personal day summary', () => {
  let prisma: any;
  let service: WorkItemsService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(date('16:00'));
    prisma = {
      worker: { findUnique: jest.fn().mockResolvedValue({ id: 'worker-a', role: 'WORKER', siteId: 'site-a' }), findMany: jest.fn() },
      workItem: { findMany: jest.fn().mockResolvedValue([]) },
      breakConfig: { findMany: jest.fn().mockResolvedValue([{ siteId: 'site-a', startHour: 12, startMin: 0, endHour: 13, endMin: 0 }]) },
    };
    service = new WorkItemsService(prisma, {} as any);
  });
  afterEach(() => jest.useRealTimers());

  function item(id = 'item-a') {
    return { id, status: 'ENDED', startedAt: date('11:00'), endedAt: date('14:00'), notes: null,
      volume: '1.5', quantity: 10, startedByWorkerId: 'worker-a', startedByWorker: { siteId: 'site-a' }, assignments: [{ workerId: 'worker-a' }] };
  }

  it('applies the actual owner site breaks to the mobile list response', async () => {
    prisma.workItem.findMany.mockResolvedValue([item(), { ...item('legacy'), startedByWorker: { siteId: null } }]);
    const result = await service.findActiveForMobile(undefined, 'ENDED', 'site-a');
    expect(result.map((r) => r.netWorkMinutes)).toEqual([120, 180]);
    expect(prisma.workItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({
      startedByWorker: { select: { id: true, name: true, employeeCode: true, siteId: true } },
    }) }));
  });
  it('counts more than 200 records without summing concurrent person time twice', async () => {
    prisma.workItem.findMany.mockResolvedValue(Array.from({ length: 205 }, (_, i) => item(`item-${i}`)));
    const result = await service.getWorkerTodaySummary('worker-a', user);
    expect(result).toMatchObject({ count: 205, volume: 307.5, quantity: 2050, minutes: 120, date: '2026-09-08' });
    const query = prisma.workItem.findMany.mock.calls[0][0];
    expect(query.take).toBeUndefined();
    expect(query.where).toEqual({
      startedAt: { gte: date('00:00'), lte: date('16:00') }, status: { in: ['ACTIVE', 'PAUSED', 'ENDED'] },
      startedByWorker: { OR: [{ siteId: 'site-a' }, { siteId: null }] },
      OR: [{ startedByWorkerId: 'worker-a' }, { assignments: { some: { workerId: 'worker-a' } } }],
    });
  });
  it('agrees with the monthly person summary for the same day including shared and paused work', async () => {
    const items = [item(), { ...item('shared'), startedAt: date('13:00'), endedAt: date('15:00'), startedByWorkerId: 'worker-b' },
      { ...item('open'), status: 'PAUSED', startedAt: date('15:00'), endedAt: null,
        notes: JSON.stringify({ pauseHistory: [{ pausedAt: date('15:30').toISOString() }] }) }];
    prisma.workItem.findMany.mockResolvedValue(items);
    prisma.worker.findMany.mockResolvedValue([{ id: 'worker-a', name: 'Worker', employeeCode: 'W1', siteId: 'site-a' }]);
    const daily = await service.getWorkerTodaySummary('worker-a', user);
    const monthly = await new DashboardService(prisma).getWorkerTimeSummary('2026-09-08', '2026-09-08', 'site-a');
    expect(daily.count).toBe(3);
    expect(daily.minutes).toBe(210);
    expect(monthly[0]).toMatchObject({ itemCount: 3, netMinutes: daily.minutes });
  });
  it('returns an actual zero summary only for an empty server result', async () => {
    await expect(service.getWorkerTodaySummary('worker-a', user)).resolves.toMatchObject({ count: 0, volume: 0, quantity: 0, minutes: 0 });
  });
  it.each([
    [{ ...user, siteId: undefined }, undefined],
    [user, 'site-b'],
  ])('fails closed on missing or forged caller site before querying records', async (requester, site) => {
    await expect(service.getWorkerTodaySummary('worker-a', requester, site)).rejects.toMatchObject({ status: 403 });
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
  it('rejects a worker from another tenant even without a query site', async () => {
    prisma.worker.findUnique.mockResolvedValue({ id: 'worker-b', siteId: 'site-b', role: 'WORKER' });
    await expect(service.getWorkerTodaySummary('worker-b', user)).rejects.toMatchObject({ status: 403 });
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
  it('lets MASTER select another site but still scopes the target worker', async () => {
    prisma.worker.findUnique.mockResolvedValue({ id: 'worker-b', siteId: 'site-b', role: 'WORKER' });
    await service.getWorkerTodaySummary('worker-b', { ...user, role: 'MASTER' });
    expect(prisma.workItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      startedByWorker: { OR: [{ siteId: 'site-b' }, { siteId: null }] },
    }) }));
  });
  it('never turns a legacy unassigned worker into an all-site query', async () => {
    prisma.worker.findUnique.mockResolvedValue({ id: 'legacy', siteId: null, role: 'WORKER' });
    await service.getWorkerTodaySummary('legacy', { ...user, role: 'MASTER' });
    expect(prisma.workItem.findMany.mock.calls[0][0].where.startedByWorker).toEqual({ siteId: null });
  });
  it('uses the KST date when the UTC calendar is still yesterday', async () => {
    jest.setSystemTime(new Date('2026-09-07T15:30:00Z'));
    const result = await service.getWorkerTodaySummary('worker-a', user);
    expect(result.date).toBe('2026-09-08');
    expect(prisma.workItem.findMany.mock.calls[0][0].where.startedAt.gte).toEqual(date('00:00'));
  });
});
