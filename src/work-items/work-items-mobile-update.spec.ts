import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';

// 태블릿 '현황' 수정 (PATCH mobile/work-items/:id → updateFromMobile) — prisma mock 기반 단위 스펙

const siteId = '00000000-0000-4000-8000-0000000000a1';
const otherSiteId = '00000000-0000-4000-8000-0000000000a2';
const id = '00000000-0000-4000-8000-000000000001';
const starterId = '00000000-0000-4000-8000-000000000011';
const coA = '00000000-0000-4000-8000-000000000012';
const coB = '00000000-0000-4000-8000-000000000013';
const foreignWorker = '00000000-0000-4000-8000-000000000014';
const adminId = '00000000-0000-4000-8000-000000000015';
const foreignAdmin = '00000000-0000-4000-8000-000000000016';
const kioskId = '00000000-0000-4000-8000-000000000017';
const classA = '00000000-0000-4000-8000-000000000021';
const classB = '00000000-0000-4000-8000-000000000022';
const foreignClass = '00000000-0000-4000-8000-000000000023';

/** 태블릿 계정: <코드>-KIOSK, SUPERVISOR */
const kiosk = { sub: kioskId, role: 'SUPERVISOR', siteId, employeeCode: 'DG-KIOSK' } as any;

const workers: Record<string, any> = {
  [starterId]: { id: starterId, name: '홍길동', siteId, status: 'ACTIVE', role: 'WORKER', employeeCode: 'W001' },
  [coA]: { id: coA, name: '김철수', siteId, status: 'ACTIVE', role: 'WORKER', employeeCode: 'W002' },
  [coB]: { id: coB, name: '이영희', siteId, status: 'ACTIVE', role: 'WORKER', employeeCode: 'W003' },
  [foreignWorker]: { id: foreignWorker, name: '타사업장', siteId: otherSiteId, status: 'ACTIVE', role: 'WORKER', employeeCode: 'X001' },
  [adminId]: { id: adminId, name: '관리자', siteId, status: 'ACTIVE', role: 'ADMIN', employeeCode: 'ADM001' },
  [foreignAdmin]: { id: foreignAdmin, name: '타관리자', siteId: otherSiteId, status: 'ACTIVE', role: 'ADMIN', employeeCode: 'ADM002' },
  [kioskId]: { id: kioskId, name: '태블릿', siteId, status: 'ACTIVE', role: 'SUPERVISOR', employeeCode: 'DG-KIOSK' },
};
const classes: Record<string, any> = {
  [classA]: { id: classA, isActive: true, siteId, code: 'DC_A', displayName: '납품처A' },
  [classB]: { id: classB, isActive: true, siteId: null, code: 'DC_B', displayName: '납품처B(전역)' },
  [foreignClass]: { id: foreignClass, isActive: true, siteId: otherSiteId, code: 'DC_X', displayName: '타사업장' },
};

function harness(overrides: Record<string, unknown> = {}) {
  const addedAt = new Date('2026-09-19T01:00:00Z');
  const item: any = {
    id, startedByWorkerId: starterId, classificationId: classA, volume: '12.5', quantity: 3,
    status: 'ACTIVE', notes: null, batchId: null, endedAt: null,
    startedAt: addedAt, createdAt: addedAt, updatedAt: addedAt,
    assignments: [
      { id: 'as1', workItemId: id, workerId: starterId, role: 'STARTER', addedAt, worker: { id: starterId, name: '홍길동' } },
      { id: 'as2', workItemId: id, workerId: coA, role: 'PARTICIPANT', addedAt, worker: { id: coA, name: '김철수' } },
    ],
    startedByWorker: { id: starterId, name: '홍길동', employeeCode: 'W001', siteId },
    classification: { id: classA, code: 'DC_A', displayName: '납품처A' },
    ...overrides,
  };
  const audit: any[] = [];
  const prisma: any = {
    workItem: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === id ? structuredClone(item) : null)),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => {
        const { classification, startedByWorker, ...scalars } = data;
        Object.assign(item, scalars);
        if (classification?.connect?.id) {
          item.classificationId = classification.connect.id;
          item.classification = { ...classes[item.classificationId] };
        }
        if (startedByWorker?.connect?.id) {
          item.startedByWorkerId = startedByWorker.connect.id;
          item.startedByWorker = { ...workers[item.startedByWorkerId] };
        }
        const { assignments: _a, startedByWorker: _s, classification: _c, ...row } = item;
        return structuredClone(row);
      }),
    },
    worker: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((w: string) => workers[w]).filter(Boolean)),
      findUnique: jest.fn(async ({ where }: any) => workers[where.id] ?? null),
    },
    classification: { findUnique: jest.fn(async ({ where }: any) => classes[where.id] ?? null) },
    workAssignment: {
      deleteMany: jest.fn(async () => { item.assignments = []; return { count: 2 }; }),
      createMany: jest.fn(async ({ data }: any) => {
        item.assignments = data.map((d: any, i: number) => ({
          id: `n${i}`, addedAt: new Date(), worker: { id: d.workerId, name: workers[d.workerId]?.name }, ...d,
        }));
        return { count: data.length };
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => { audit.push(data); return data; }) },
    breakConfig: { findMany: jest.fn(async () => []) },
    $transaction: (run: any) => run(prisma),
  };
  return { service: new WorkItemsService(prisma, {} as any), prisma, audit, item: () => item };
}

describe('updateFromMobile (태블릿 현황 수정)', () => {
  it('다른 사업장의 기록은 변경 없이 거부한다', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { quantity: 5 }, undefined, undefined, { ...kiosk, siteId: otherSiteId }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.workItem.update).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(0);
  });

  it('사업장 미배정 계정은 거부한다', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { quantity: 5 }, undefined, undefined, { ...kiosk, siteId: undefined }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('무효화(VOID)된 기록은 400', async () => {
    const h = harness({ status: 'VOID' });
    await expect(h.service.updateFromMobile(id, { quantity: 5 }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.workItem.update).not.toHaveBeenCalled();
  });

  it('수정 항목이 없으면 400', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { reason: '사유만' }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('다른 사업장 작업자로 교체하면 거부한다', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { workerId: foreignWorker }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.workItem.update).not.toHaveBeenCalled();
    expect(h.prisma.workAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it('관리 역할·키오스크 계정·미존재 작업자는 배정할 수 없다', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { workerId: adminId }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.updateFromMobile(id, { coWorkerIds: [kioskId] }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.updateFromMobile(id, { coWorkerIds: ['00000000-0000-4000-8000-0000000000ff'] }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.workItem.update).not.toHaveBeenCalled();
  });

  it('coWorkerIds 교체 시 assignments 를 deleteMany + createMany 로 재구성한다 (중복·시작 작업자 제외)', async () => {
    const h = harness();
    await h.service.updateFromMobile(id, { coWorkerIds: [coB, coB, starterId] }, '127.0.0.1', 'jest', kiosk);

    expect(h.prisma.workAssignment.deleteMany).toHaveBeenCalledWith({ where: { workItemId: id } });
    expect(h.prisma.workAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { workItemId: id, workerId: starterId, role: 'STARTER' },
        { workItemId: id, workerId: coB, role: 'PARTICIPANT' },
      ],
    });
    expect(h.audit).toHaveLength(1);
    const log = h.audit[0];
    expect(log).toMatchObject({
      action: 'EDIT', workItemId: id, actorWorkerId: kioskId, reason: '태블릿에서 수정', ip: '127.0.0.1', userAgent: 'jest',
    });
    expect(JSON.parse(log.before).assignments.map((a: any) => a.workerId)).toEqual([starterId, coA]);
    expect(JSON.parse(log.after).assignments.map((a: any) => a.workerId)).toEqual([starterId, coB]);
  });

  it('시작 작업자 교체 시 STARTER 행을 바꾸고 기존 공동작업자는 유지한다', async () => {
    const h = harness();
    const result = await h.service.updateFromMobile(id, { workerId: coB }, undefined, undefined, kiosk);

    expect(h.prisma.workItem.update).toHaveBeenCalledWith({
      where: { id },
      data: { startedByWorker: { connect: { id: coB } } },
    });
    expect(h.prisma.workAssignment.createMany).toHaveBeenCalledWith({
      data: [
        { workItemId: id, workerId: coB, role: 'STARTER' },
        { workItemId: id, workerId: coA, role: 'PARTICIPANT' },
      ],
    });
    expect(result.startedByWorkerId).toBe(coB);
  });

  it('quantity/volume 은 Number 로 저장한다', async () => {
    const h = harness();
    await h.service.updateFromMobile(id, { quantity: '7' as any, volume: '3.5' as any }, undefined, undefined, kiosk);
    expect(h.prisma.workItem.update).toHaveBeenCalledWith({ where: { id }, data: { quantity: 7, volume: 3.5 } });
    expect(h.prisma.workAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it('비고: 평문은 교체하고 빈 값은 null, pauseHistory JSON 은 이력을 보존한 채 memo 로 병합한다', async () => {
    const plain = harness({ notes: '쿠팡' });
    await plain.service.updateFromMobile(id, { notes: ' 파손 2건 ' }, undefined, undefined, kiosk);
    expect(plain.item().notes).toBe('파손 2건');
    await plain.service.updateFromMobile(id, { notes: '' }, undefined, undefined, kiosk);
    expect(plain.item().notes).toBeNull();

    const history = [{ pausedAt: '2026-09-19T02:00:00.000Z', pausedByWorkerId: starterId, resumedAt: '2026-09-19T02:10:00.000Z' }];
    const paused = harness({ status: 'PAUSED', notes: JSON.stringify({ pauseHistory: history }) });
    await paused.service.updateFromMobile(id, { notes: '파손' }, undefined, undefined, kiosk);
    expect(JSON.parse(paused.item().notes)).toEqual({ pauseHistory: history, memo: '파손' });
    await paused.service.updateFromMobile(id, { notes: '' }, undefined, undefined, kiosk);
    expect(JSON.parse(paused.item().notes)).toEqual({ pauseHistory: history });
  });

  it('분류: 다른 사업장 분류는 거부, 전역(siteId NULL) 분류는 허용', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { classificationId: foreignClass }, undefined, undefined, kiosk))
      .rejects.toBeInstanceOf(ForbiddenException);
    const result = await h.service.updateFromMobile(id, { classificationId: classB }, undefined, undefined, kiosk);
    expect(h.prisma.workItem.update).toHaveBeenCalledWith({
      where: { id },
      data: { classification: { connect: { id: classB } } },
    });
    expect(result.classification.displayName).toBe('납품처B(전역)');
  });

  it('actorWorkerId 가 같은 사업장 관리자면 감사 actor, 아니면 JWT 계정으로 기록한다', async () => {
    const h = harness();
    await h.service.updateFromMobile(id, { quantity: 1, actorWorkerId: adminId, reason: '  수량 오입력  ' }, undefined, undefined, kiosk);
    await h.service.updateFromMobile(id, { quantity: 2, actorWorkerId: foreignAdmin }, undefined, undefined, kiosk);
    await h.service.updateFromMobile(id, { quantity: 3, actorWorkerId: coA }, undefined, undefined, kiosk);
    expect(h.audit.map((a) => a.actorWorkerId)).toEqual([adminId, kioskId, kioskId]);
    expect(h.audit[0].reason).toBe('수량 오입력');
  });

  it('WORKER 토큰은 본인이 시작/참여한 작업만 수정할 수 있다', async () => {
    const h = harness();
    await expect(h.service.updateFromMobile(id, { quantity: 9 }, undefined, undefined, { sub: coB, role: 'WORKER', siteId } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.updateFromMobile(id, { quantity: 9 }, undefined, undefined, { sub: coA, role: 'WORKER', siteId } as any))
      .resolves.toMatchObject({ quantity: 9 });
  });

  it('응답은 모바일 목록 항목과 같은 형태다', async () => {
    const h = harness();
    const result = await h.service.updateFromMobile(id, { quantity: 4 }, undefined, undefined, kiosk);
    expect(result).toMatchObject({
      id, quantity: 4, status: 'ACTIVE',
      classification: { id: classA, code: 'DC_A', displayName: '납품처A' },
      startedByWorker: { id: starterId, name: '홍길동', siteId },
      concurrentCount: 1,
    });
    expect(result.assignments.map((a: any) => a.worker.name)).toEqual(['홍길동', '김철수']);
    expect(typeof result.netWorkMinutes).toBe('number');
    expect('adjustedMinutes' in result).toBe(true);
  });
});
