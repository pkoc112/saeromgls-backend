import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';
import { calcNetWorkMinutes } from '../common/utils/net-work-minutes';

const workerId = '00000000-0000-4000-8000-000000000001';
const siteId = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const requester = { sub: workerId, siteId, role: 'ADMIN' } as any;

function harness() {
  let work: any = null;
  const audit: any[] = [], calls: string[] = [];
  let tail = Promise.resolve();
  const prisma: any = {
    worker: { findUnique: async () => ({ id: workerId, status: 'ACTIVE', siteId }) },
    classification: { findUnique: async () => ({ isActive: true, siteId }) },
    workAssignment: { create: async () => ({}) },
    workItem: {
      findUnique: async ({ where }: any) => { calls.push('read'); return where.idempotencyKey ? null : structuredClone(work); },
      create: async ({ data }: any) => {
        work = { id, assignments: [], startedByWorker: { siteId }, updatedAt: new Date(), ...data };
        return structuredClone(work);
      },
      update: async ({ data }: any) => { calls.push(data.status); Object.assign(work, data); return structuredClone(work); },
    },
    auditLog: {
      create: async ({ data }: any) => { audit.push(data); return data; },
      findFirst: async ({ where }: any) => audit.find((a) => a.workItemId === where.workItemId &&
        a.action === where.action && a.actorWorkerId === where.actorWorkerId && a.after.includes(where.after.contains)),
    },
    $queryRaw: async (sql: TemplateStringsArray, value: string) => {
      expect(sql.join('?')).toMatch(/SELECT id FROM work_items WHERE id = \?::uuid FOR UPDATE/);
      expect(value).toBe(id); calls.push('lock'); return [{ id }];
    },
    $transaction: (run: any) => {
      const next = tail.then(() => run(prisma));
      tail = next.catch(() => {});
      return next;
    },
  };
  return { service: new WorkItemsService(prisma, {} as any), prisma, calls, audit, work: () => work };
}

describe('mobile event persistence', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-08T10:00:00Z')));
  afterEach(() => jest.useRealTimers());
  const start = async (h: ReturnType<typeof harness>) => h.service.create({
    startedByWorkerId: workerId, classificationId: id, occurredAt: '2026-09-08T01:00:00Z', volume: 1, quantity: 5,
  }, undefined, undefined, requester);
  const pause = { pausedByWorkerId: workerId, occurredAt: '2026-09-08T01:20:00Z', eventId: '00000000-0000-4000-8000-000000000010' };
  const resume = { occurredAt: '2026-09-08T01:30:00Z', eventId: '00000000-0000-4000-8000-000000000011' };
  const end = { endedByWorkerId: workerId, occurredAt: '2026-09-08T02:00:00Z', eventId: '00000000-0000-4000-8000-000000000012' };

  it('preserves a one-hour offline session with ten minutes paused after a late sync', async () => {
    const h = harness(); await start(h);
    await h.service.pauseWorkItem(id, pause, undefined, undefined, requester);
    await h.service.resumeWorkItem(id, workerId, undefined, undefined, requester, resume);
    await h.service.endWorkItem(id, end, undefined, undefined, requester);
    const work = h.work();
    expect(work.endedAt.getTime() - work.startedAt.getTime()).toBe(3600000);
    expect(calcNetWorkMinutes(work.startedAt, work.endedAt, work.notes, [])).toBe(50);
    expect(work.status).toBe('ENDED');
  });
  it('acknowledges response-loss retries without another update or audit entry', async () => {
    const h = harness(); await start(h);
    await h.service.pauseWorkItem(id, pause, undefined, undefined, requester);
    await h.service.resumeWorkItem(id, workerId, undefined, undefined, requester, resume);
    await h.service.endWorkItem(id, end, undefined, undefined, requester);
    await h.service.pauseWorkItem(id, pause, undefined, undefined, requester);
    await h.service.resumeWorkItem(id, workerId, undefined, undefined, requester, resume);
    await h.service.endWorkItem(id, end, undefined, undefined, requester);
    expect(h.audit).toHaveLength(4); expect(h.work().status).toBe('ENDED');
  });
  it('locks before state reads so a slow pause cannot overwrite a completed end', async () => {
    const h = harness(); await start(h); h.calls.length = 0;
    await Promise.all([
      h.service.pauseWorkItem(id, pause, undefined, undefined, requester),
      h.service.endWorkItem(id, end, undefined, undefined, requester),
    ]);
    expect(h.calls[0]).toBe('lock');
    expect(h.calls.filter((c) => ['PAUSED', 'ENDED'].includes(c))).toEqual(['PAUSED', 'ENDED']);
    expect(h.work().status).toBe('ENDED');
  });
  it('rejects a new late pause against an ended work item', async () => {
    const h = harness(); await start(h);
    await h.service.endWorkItem(id, end, undefined, undefined, requester);
    await expect(h.service.pauseWorkItem(id, pause, undefined, undefined, requester)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.work().status).toBe('ENDED');
  });
  it('checks tenant ownership even for a duplicate event', async () => {
    const h = harness(); await start(h);
    await h.service.pauseWorkItem(id, pause, undefined, undefined, requester);
    await expect(h.service.pauseWorkItem(id, pause, undefined, undefined, { ...requester, siteId: 'foreign' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.audit).toHaveLength(2);
  });
  it('accepts legacy clients without event metadata', async () => {
    const h = harness(); await start(h);
    await h.service.pauseWorkItem(id, { pausedByWorkerId: workerId }, undefined, undefined, requester);
    await h.service.resumeWorkItem(id, workerId, undefined, undefined, requester);
    await h.service.endWorkItem(id, { endedByWorkerId: workerId }, undefined, undefined, requester);
    expect(h.work().endedAt.toISOString()).toBe('2026-09-08T10:00:00.000Z');
  });
});
