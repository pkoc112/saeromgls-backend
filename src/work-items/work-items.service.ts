import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';
import { calculateBatchAdjustedTime } from '../common/utils/batch-time.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { EndWorkItemDto } from './dto/end-work-item.dto';
import { PauseWorkItemDto } from './dto/pause-work-item.dto';
import { UpdateWorkItemDto, VoidWorkItemDto, ForceEndWorkItemDto } from './dto/update-work-item.dto';
import { QueryWorkItemsDto } from './dto/query-work-items.dto';
import { CreateManualWorkItemDto } from './dto/create-manual-work-item.dto';
import { BulkWorkItemsDto } from './dto/bulk-work-items.dto';
import { Prisma } from '@prisma/client';

import {
  calcNetWorkMinutes,
  loadBreakConfigResolver,
} from '../common/utils/net-work-minutes';
import { assertWorkItemOwnership } from '../common/utils/work-item-ownership';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class WorkItemsService {
  private readonly logger = new Logger(WorkItemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  // ======================== Mobile ========================

  /**
   * 모바일: 작업 시작 (생성)
   * 멱등성 키가 있으면 중복 생성 방지
   */
  async create(
    dto: CreateWorkItemDto,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ) {
    // 멱등성 키 중복 확인 -- 네트워크 재시도 시 동일 작업이 중복 생성되지 않도록
    if (dto.idempotencyKey) {
      const existing = await this.prisma.workItem.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: {
          classification: { select: { code: true, displayName: true } },
          startedByWorker: { select: { id: true, name: true, employeeCode: true } },
          assignments: {
            include: { worker: { select: { id: true, name: true, employeeCode: true } } },
          },
        },
      });

      if (existing) {
        this.logger.log(`Idempotent hit: ${dto.idempotencyKey}`);
        return existing;
      }
    }

    // 작업자/분류 존재·활성 확인 + siteId 격리 + 참여자 검증 (수기 등록과 공용 헬퍼)
    const { participantIds } = await this.validateCreateTargets({
      startedByWorkerId: dto.startedByWorkerId,
      classificationId: dto.classificationId,
      participantWorkerIds: dto.participantWorkerIds,
      requester,
    });

    // 트랜잭션으로 작업 + 배정 + 감사로그 동시 생성
    const workItem = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.create({
        data: {
          startedByWorkerId: dto.startedByWorkerId,
          classificationId: dto.classificationId,
          volume: dto.volume ?? 0,
          quantity: dto.quantity ?? 0,
          deviceId: dto.deviceId,
          notes: dto.notes,
          idempotencyKey: dto.idempotencyKey,
          batchId: dto.batchId || null,
          status: 'ACTIVE',
        },
      });

      // 시작 작업자를 STARTER로 배정
      await tx.workAssignment.create({
        data: {
          workItemId: item.id,
          workerId: dto.startedByWorkerId,
          role: 'STARTER',
        },
      });

      // 추가 참여자 배정 (시작 작업자 제외·중복 제거된 목록)
      for (const participantId of participantIds) {
        await tx.workAssignment.create({
          data: {
            workItemId: item.id,
            workerId: participantId,
            role: 'PARTICIPANT',
          },
        });
      }

      // 감사 로그 생성
      await tx.auditLog.create({
        data: {
          actorWorkerId: dto.startedByWorkerId,
          workItemId: item.id,
          action: 'CREATE',
          after: JSON.stringify(item),
          ip,
          userAgent,
        },
      });

      return item;
    });

    // 관계 포함하여 반환
    return this.findOneRaw(workItem.id);
  }

  /**
   * 작업 생성 대상 검증 (create / createManualForAdmin 공용)
   * - 작업자 존재·ACTIVE, 분류 존재·isActive 확인
   * - ★ siteId 격리: 비-MASTER 호출자는 자기 사업장 자원만 사용 가능.
   *   - 작업자/분류가 "다른 사업장" 소속이면 차단 (cross-tenant 위조 작업 주입 방지)
   *   - 작업자 siteId=NULL(레거시 미배정)·분류 siteId=NULL(전역 공통)은 호환 허용
   *   - MASTER: 기본은 격리 없음. masterScopeToWorkerSite=true 면 시작 작업자의 siteId 를
   *     기준으로 분류/참여자 일치 검증 (수기 등록 — 서로 다른 사업장 자원 섞임 방지)
   * - ★ 참여자 검증: 존재 확인 + 동일 사업장만 허용. 시작 작업자 제외·중복 제거한 목록 반환
   */
  private async validateCreateTargets(params: {
    startedByWorkerId: string;
    classificationId: string;
    participantWorkerIds?: string[];
    requester?: JwtPayload;
    masterScopeToWorkerSite?: boolean;
  }) {
    const { startedByWorkerId, classificationId, participantWorkerIds, requester } = params;

    // 작업자 존재 확인
    const worker = await this.prisma.worker.findUnique({
      where: { id: startedByWorkerId },
    });
    if (!worker || worker.status !== 'ACTIVE') {
      throw new BadRequestException('유효하지 않은 작업자입니다');
    }

    // 분류 존재 확인
    const classification = await this.prisma.classification.findUnique({
      where: { id: classificationId },
    });
    if (!classification || !classification.isActive) {
      throw new BadRequestException('유효하지 않은 분류입니다');
    }

    let callerSiteId: string | undefined;
    if (requester && requester.role !== 'MASTER') {
      callerSiteId = requester.siteId;
    } else if (requester && params.masterScopeToWorkerSite) {
      callerSiteId = worker.siteId ?? undefined;
    }

    if (callerSiteId) {
      if (worker.siteId && worker.siteId !== callerSiteId) {
        throw new ForbiddenException('다른 사업장의 작업자로 작업을 시작할 수 없습니다');
      }
      if (classification.siteId && classification.siteId !== callerSiteId) {
        throw new ForbiddenException('다른 사업장의 분류로 작업을 시작할 수 없습니다');
      }
    }

    let participantIds: string[] = [];
    if (participantWorkerIds && participantWorkerIds.length > 0) {
      participantIds = [
        ...new Set(participantWorkerIds.filter((id) => id !== startedByWorkerId)),
      ];
      if (participantIds.length > 0) {
        const participants = await this.prisma.worker.findMany({
          where: { id: { in: participantIds } },
          select: { id: true, siteId: true },
        });
        if (participants.length !== participantIds.length) {
          throw new BadRequestException('존재하지 않는 참여 작업자가 포함되어 있습니다');
        }
        if (callerSiteId) {
          const foreign = participants.find(
            (p) => p.siteId && p.siteId !== callerSiteId,
          );
          if (foreign) {
            throw new ForbiddenException(
              '다른 사업장의 작업자는 참여자로 추가할 수 없습니다',
            );
          }
        }
      }
    }

    return { worker, classification, participantIds };
  }

  /**
   * 모바일: 작업 목록 조회
   * status 파라미터로 쉼표 구분 다중 상태 필터 가능 (예: "ACTIVE,PAUSED")
   * 기본값은 ACTIVE
   */
  async findActiveForMobile(
    workerId?: string,
    statusFilter?: string,
    siteId?: string,
    from?: string,
    to?: string,
  ) {
    const statuses = statusFilter
      ? statusFilter.split(',').map((s) => s.trim().toUpperCase())
      : ['ACTIVE'];

    const where: Prisma.WorkItemWhereInput = {
      status: statuses.length === 1 ? statuses[0] : { in: statuses },
    };

    // ★ 사업장 격리: 해당 사업장 작업자 + siteId NULL 작업자
    if (siteId) {
      where.startedByWorker = {
        OR: [{ siteId }, { siteId: null }],
      };
    }

    // 특정 작업자의 작업만 필터
    if (workerId) {
      where.OR = [
        { startedByWorkerId: workerId },
        { assignments: { some: { workerId } } },
      ];
    }

    // 날짜 범위 필터 (from/to 둘 다 옵션)
    // - YYYY-MM-DD 형식: KST 자정(from) / KST 23:59:59(to)으로 보정
    // - ISO 8601: 그대로 사용
    // - 잘못된 형식: BadRequestException
    const parseBound = (value: string | undefined, kind: 'from' | 'to'): Date | undefined => {
      if (!value) return undefined;
      let date: Date;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        // KST 기준 자정/말일로 변환 (UTC offset +09:00)
        date = kind === 'from'
          ? new Date(`${value}T00:00:00+09:00`)
          : new Date(`${value}T23:59:59.999+09:00`);
      } else {
        date = new Date(value);
      }
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException(`${kind} 날짜 형식이 올바르지 않습니다 (YYYY-MM-DD 또는 ISO 8601)`);
      }
      return date;
    };

    const fromDate = parseBound(from, 'from');
    const toDate = parseBound(to, 'to');
    if (fromDate && toDate && fromDate > toDate) {
      throw new BadRequestException('from은 to보다 늦을 수 없습니다');
    }
    if (fromDate || toDate) {
      where.startedAt = {};
      if (fromDate) (where.startedAt as Prisma.DateTimeFilter).gte = fromDate;
      if (toDate) (where.startedAt as Prisma.DateTimeFilter).lte = toDate;
    }

    const data = await this.prisma.workItem.findMany({
      where,
      include: {
        classification: { select: { id: true, code: true, displayName: true } },
        startedByWorker: { select: { id: true, name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });

    // 동시작업 시간 비례 분배
    const batchMap = calculateBatchAdjustedTime(
      data.map((d) => ({
        id: d.id,
        startedByWorkerId: d.startedByWorkerId,
        batchId: d.batchId || null,
        volume: d.volume,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
      })),
    );

    return data.map((d) => {
      const adj = batchMap.get(d.id);
      return {
        ...d,
        adjustedMinutes: adj?.adjustedMinutes ?? null,
        concurrentCount: adj?.concurrentCount ?? 1,
        netWorkMinutes: calcNetWorkMinutes(d.startedAt, d.endedAt, d.notes),
      };
    });
  }

  /**
   * 모바일: 작업 종료
   * 종료 시 물량/수량 확정, 추가 참여자 등록 가능
   */
  async endWorkItem(id: string, dto: EndWorkItemDto, ip?: string, userAgent?: string, requester?: JwtPayload) {
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    // P0-4: 소유자 검증 — 주작업자/배정 참여자 또는 관리자만
    if (requester) {
      assertWorkItemOwnership({
        requesterId: requester.sub,
        requesterRole: requester.role,
        workItem,
        dtoWorkerId: (dto as any).endedByWorkerId,
      });
    }

    if (workItem.status !== 'ACTIVE' && workItem.status !== 'PAUSED') {
      throw new BadRequestException('이미 종료되었거나 무효화된 작업입니다');
    }

    // P1-24: 작업 시간 역전 방지 — endedAt이 startedAt보다 이르지 않도록
    const now = new Date();
    const effectiveEndedAt = now.getTime() < workItem.startedAt.getTime() ? workItem.startedAt : now;

    const beforeState = JSON.stringify(workItem);

    const updated = await this.prisma.$transaction(async (tx) => {
      // 작업 종료 처리
      const item = await tx.workItem.update({
        where: { id },
        data: {
          endedByWorkerId: dto.endedByWorkerId,
          endedAt: effectiveEndedAt,
          status: 'ENDED',
          volume: dto.volume !== undefined ? dto.volume : workItem.volume,
          quantity: dto.quantity !== undefined ? dto.quantity : workItem.quantity,
          notes: dto.notes !== undefined ? dto.notes : workItem.notes,
        },
      });

      // 추가 참여자 배정
      if (dto.participantWorkerIds && dto.participantWorkerIds.length > 0) {
        const existingWorkerIds = workItem.assignments.map((a) => a.workerId);

        for (const participantId of dto.participantWorkerIds) {
          if (!existingWorkerIds.includes(participantId)) {
            await tx.workAssignment.create({
              data: {
                workItemId: id,
                workerId: participantId,
                role: 'PARTICIPANT',
              },
            });
          }
        }
      }

      // 감사 로그
      await tx.auditLog.create({
        data: {
          actorWorkerId: dto.endedByWorkerId,
          workItemId: id,
          action: 'END',
          before: beforeState,
          after: JSON.stringify(item),
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneRaw(updated.id);
  }

  /**
   * 모바일: 작업 중간마감 (일시정지)
   * ACTIVE -> PAUSED 상태로 변경, pausedAt 시각을 notes에 JSON으로 기록
   */
  async pauseWorkItem(id: string, dto: PauseWorkItemDto, ip?: string, userAgent?: string, requester?: JwtPayload) {
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    // P0-4: 소유자 검증
    if (requester) {
      assertWorkItemOwnership({
        requesterId: requester.sub,
        requesterRole: requester.role,
        workItem,
        dtoWorkerId: (dto as any).pausedByWorkerId,
      });
    }

    if (workItem.status !== 'ACTIVE') {
      throw new BadRequestException('활성 상태의 작업만 중간마감할 수 있습니다');
    }

    const beforeState = JSON.stringify(workItem);
    const now = new Date();

    // notes 필드에 pause 이력을 JSON으로 누적
    let pauseHistory: Array<{ pausedAt: string; pausedByWorkerId: string; resumedAt?: string }> = [];
    if (workItem.notes) {
      try {
        const parsed = JSON.parse(workItem.notes);
        if (Array.isArray(parsed?.pauseHistory)) {
          pauseHistory = parsed.pauseHistory;
        }
      } catch {
        // notes가 JSON이 아닌 경우 무시
      }
    }
    pauseHistory.push({
      pausedAt: now.toISOString(),
      pausedByWorkerId: dto.pausedByWorkerId,
    });

    const notesJson = JSON.stringify({ pauseHistory });

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: {
          status: 'PAUSED',
          notes: notesJson,
        },
      });

      await tx.auditLog.create({
        data: {
          actorWorkerId: dto.pausedByWorkerId,
          workItemId: id,
          action: 'PAUSE',
          before: beforeState,
          after: JSON.stringify(item),
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneRaw(updated.id);
  }

  /**
   * 모바일: 중간마감 해제 (이어하기)
   * PAUSED -> ACTIVE 상태로 변경
   */
  async resumeWorkItem(id: string, resumedByWorkerId: string, ip?: string, userAgent?: string, requester?: JwtPayload) {
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    // P0-4: 소유자 검증 (이어하기 하는 작업자가 권한 있는지)
    if (requester) {
      assertWorkItemOwnership({
        requesterId: requester.sub,
        requesterRole: requester.role,
        workItem,
        dtoWorkerId: resumedByWorkerId,
      });
    }

    if (workItem.status !== 'PAUSED') {
      throw new BadRequestException('중간마감 상태의 작업만 이어하기할 수 있습니다');
    }

    const beforeState = JSON.stringify(workItem);
    const now = new Date();

    // notes의 pauseHistory에 resumedAt 기록
    let notesJson = workItem.notes;
    if (workItem.notes) {
      try {
        const parsed = JSON.parse(workItem.notes);
        if (Array.isArray(parsed?.pauseHistory) && parsed.pauseHistory.length > 0) {
          const lastEntry = parsed.pauseHistory[parsed.pauseHistory.length - 1];
          if (!lastEntry.resumedAt) {
            lastEntry.resumedAt = now.toISOString();
          }
          notesJson = JSON.stringify(parsed);
        }
      } catch {
        // notes가 JSON이 아닌 경우 그대로 유지
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          notes: notesJson,
        },
      });

      await tx.auditLog.create({
        data: {
          actorWorkerId: resumedByWorkerId,
          workItemId: id,
          action: 'RESUME',
          before: beforeState,
          after: JSON.stringify(item),
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneRaw(updated.id);
  }

  // ======================== Admin ========================

  /**
   * 단건 work-item 사업장 소유권 검증 헬퍼
   * - MASTER: 모든 work-item 접근 가능
   * - ADMIN/SUPERVISOR: startedByWorker.siteId 일치 (또는 NULL legacy)만 가능
   * - 사업장 배정 없는 ADMIN: 접근 차단
   */
  private async assertSiteOwnership(
    workItemId: string,
    requester?: JwtPayload,
  ): Promise<void> {
    if (!requester || requester.role === 'MASTER') return;
    if (!requester.siteId) {
      throw new ForbiddenException('사업장이 배정되지 않은 계정은 접근할 수 없습니다');
    }
    const item = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: { id: true, startedByWorker: { select: { siteId: true } } },
    });
    if (!item) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }
    const itemSiteId = item.startedByWorker?.siteId ?? null;
    // legacy(siteId NULL) 데이터는 통과시키되, 명시적 다른 사업장은 차단
    if (itemSiteId && itemSiteId !== requester.siteId) {
      throw new ForbiddenException('다른 사업장의 작업은 접근할 수 없습니다');
    }
  }

  /**
   * 관리자 목록/CSV 내보내기 공용 where 빌더
   * siteId 격리(OR NULL 패턴) + 상태/분류/작업자/날짜 범위 필터
   */
  private buildAdminWhere(query: QueryWorkItemsDto, siteId?: string): Prisma.WorkItemWhereInput {
    const where: Prisma.WorkItemWhereInput = {};

    // ★ siteId 격리: 해당 사업장 작업자 + siteId 미배정 작업자 모두 포함
    // (기존 작업자가 siteId=NULL일 수 있으므로 NULL도 포함)
    if (siteId) {
      where.startedByWorker = {
        OR: [
          { siteId },
          { siteId: null },
        ],
      };
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.classificationId) {
      where.classificationId = query.classificationId;
    }

    // 작업자 필터: 시작 작업자 또는 배정 참여자
    const workerOr: Prisma.WorkItemWhereInput[] | null = query.workerId
      ? [
          { startedByWorkerId: query.workerId },
          { assignments: { some: { workerId: query.workerId } } },
        ]
      : null;

    // 검색어: 작업자명·분류표시명·비고 부분 일치 (대소문자 무시). 빈 문자열/공백은 무시
    // ※ startedByWorker 조건은 OR 항목 내부에만 두어 상단 siteId 격리(where.startedByWorker)를 덮어쓰지 않음
    const search = query.search?.trim();
    const searchOr: Prisma.WorkItemWhereInput[] | null = search
      ? [
          { notes: { contains: search, mode: 'insensitive' } },
          { startedByWorker: { name: { contains: search, mode: 'insensitive' } } },
          { classification: { displayName: { contains: search, mode: 'insensitive' } } },
        ]
      : null;

    // 작업자 OR와 검색 OR가 둘 다 있으면 AND로 결합 (서로 덮어쓰기 방지)
    if (workerOr && searchOr) {
      where.AND = [{ OR: workerOr }, { OR: searchOr }];
    } else if (workerOr) {
      where.OR = workerOr;
    } else if (searchOr) {
      where.OR = searchOr;
    }

    // 날짜 범위 필터 (KST 기준)
    if (query.from || query.to) {
      where.startedAt = {};
      if (query.from) {
        where.startedAt.gte = kstStartOfDay(query.from);
      }
      if (query.to) {
        where.startedAt.lte = kstEndOfDay(query.to);
      }
    }

    return where;
  }

  /**
   * 관리자: 작업 목록 조회 (페이지네이션, 필터)
   */
  async findAllForAdmin(query: QueryWorkItemsDto, siteId?: string) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = this.buildAdminWhere(query, siteId);

    const [data, total] = await Promise.all([
      this.prisma.workItem.findMany({
        where,
        include: {
          classification: { select: { id: true, code: true, displayName: true } },
          startedByWorker: { select: { id: true, name: true, employeeCode: true, siteId: true } },
          endedByWorker: { select: { id: true, name: true, employeeCode: true } },
          assignments: {
            include: { worker: { select: { id: true, name: true, employeeCode: true } } },
          },
        },
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.workItem.count({ where }),
    ]);

    // 동시작업 시간 비례 분배 계산
    const batchMap = calculateBatchAdjustedTime(
      data.map((d) => ({
        id: d.id,
        startedByWorkerId: d.startedByWorkerId,
        batchId: (d as any).batchId || null,
        volume: d.volume,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
      })),
    );

    // 순작업시간 계산용 휴게시간 설정 (작업자 siteId 기준, NULL 작업자는 전역) — #33
    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...data.map((d) => d.startedByWorker?.siteId),
    ]);

    const enriched = data.map((d) => {
      const adj = batchMap.get(d.id);
      return {
        ...d,
        adjustedMinutes: adj?.adjustedMinutes ?? null,
        rawMinutes: adj?.rawMinutes ?? null,
        concurrentCount: adj?.concurrentCount ?? 1,
        // 순작업시간(분): 중간마감·휴게시간 차감, Math.round. 진행 중이면 현재까지.
        // 종료 시각 없는 VOID 는 의미 없으므로 null
        netWorkMinutes:
          d.status === 'VOID' && !d.endedAt
            ? null
            : calcNetWorkMinutes(
                d.startedAt,
                d.endedAt,
                d.notes,
                breaks.forSite(d.startedByWorker?.siteId),
              ),
      };
    });

    return {
      data: enriched,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 관리자: 작업 기록 CSV 내보내기
   * 목록 조회(findAllForAdmin)와 동일한 필터(siteId 격리 + 상태/분류/작업자/날짜)를 적용하되
   * 페이지네이션 없이 최대 10,000건. 출력 형식은 DashboardService.exportCsv 와 동일 (BOM + 한글 헤더)
   */
  async exportCsvForAdmin(query: QueryWorkItemsDto, siteId?: string): Promise<string> {
    const MAX_CSV_ROWS = 10000;
    const where = this.buildAdminWhere(query, siteId);

    const items = await this.prisma.workItem.findMany({
      where,
      include: {
        classification: { select: { code: true, displayName: true } },
        startedByWorker: { select: { name: true, employeeCode: true, siteId: true } },
        endedByWorker: { select: { name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { name: true, employeeCode: true } } },
        },
      },
      orderBy: { startedAt: 'asc' },
      take: MAX_CSV_ROWS,
    });

    // 순작업시간 계산용 휴게시간 설정 (작업자 siteId 기준, NULL 작업자는 전역) — #33
    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...items.map((i) => i.startedByWorker?.siteId),
    ]);

    // CSV 헤더 (한글) — DashboardService.exportCsv 와 동일
    const headers = [
      '작업ID',
      '상태',
      '분류코드',
      '분류명',
      '시작작업자사번',
      '시작작업자명',
      '종료작업자사번',
      '종료작업자명',
      '물량',
      '수량',
      '시작시각',
      '종료시각',
      '작업시간(분)',
      '순작업시간(분)',
      '참여자',
      '비고',
    ];

    const rows = items.map((item) => {
      // 작업 시간 계산 (분)
      let durationMinutes = '';
      // 순작업시간 (중간마감·휴게시간 차감, Math.round) — 종료된 작업만
      let netMinutes = '';
      if (item.endedAt && item.startedAt) {
        const diff = (item.endedAt.getTime() - item.startedAt.getTime()) / 60000;
        durationMinutes = diff.toFixed(1);
        netMinutes = String(
          calcNetWorkMinutes(
            item.startedAt,
            item.endedAt,
            item.notes,
            breaks.forSite(item.startedByWorker?.siteId),
          ),
        );
      }

      // 참여자 목록
      const participants = item.assignments
        .map((a) => `${a.worker.name}(${a.worker.employeeCode})`)
        .join('; ');

      return [
        item.id,
        item.status,
        item.classification.code,
        item.classification.displayName,
        item.startedByWorker.employeeCode,
        item.startedByWorker.name,
        item.endedByWorker?.employeeCode || '',
        item.endedByWorker?.name || '',
        item.volume.toString(),
        item.quantity.toString(),
        item.startedAt.toISOString(),
        item.endedAt?.toISOString() || '',
        durationMinutes,
        netMinutes,
        participants,
        item.notes || '',
      ];
    });

    // BOM + CSV 생성 (Excel 한글 호환)
    const bom = '\uFEFF';
    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n');

    return bom + csvContent;
  }

  /**
   * 관리자: 작업 기록 수기 등록 (#35)
   * - 이미 끝난 작업을 웹에서 사후 등록: 상태 ENDED, endedByWorkerId = 등록 관리자, deviceId 'web-manual'
   * - 검증: startedAt ≤ endedAt ≤ now
   * - 격리: create() 와 동일한 작업자/분류/참여자 siteId 검증 (MASTER 는 시작 작업자의 siteId 기준)
   * - notes '[수기등록] '+사유, AuditLog action 'MANUAL_CREATE' (after JSON + reason)
   * - 트랜잭션 (작업 + 배정 + 감사로그)
   */
  async createManualForAdmin(
    dto: CreateManualWorkItemDto,
    user: JwtPayload,
    ip?: string,
    userAgent?: string,
  ) {
    // 비-MASTER 는 사업장 배정 필수 (assertSiteOwnership 과 동일 정책 — 격리 불가 계정 차단)
    if (user.role !== 'MASTER' && !user.siteId) {
      throw new ForbiddenException('사업장이 배정되지 않은 계정은 작업을 등록할 수 없습니다');
    }

    const startedAt = new Date(dto.startedAt);
    const endedAt = new Date(dto.endedAt);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      throw new BadRequestException('시작/종료 시간 형식이 올바르지 않습니다');
    }
    if (startedAt.getTime() > endedAt.getTime()) {
      throw new BadRequestException('시작 시간이 종료 시간보다 늦을 수 없습니다');
    }
    if (endedAt.getTime() > Date.now()) {
      throw new BadRequestException('종료 시간은 현재 시각 이전이어야 합니다');
    }

    const reason = dto.reason.trim();
    if (reason.length < 2) {
      throw new BadRequestException('사유는 2자 이상 200자 이하로 입력해주세요');
    }

    // 작업자/분류/참여자 존재·활성 + siteId 격리 (MASTER 는 시작 작업자 siteId 기준)
    const { participantIds } = await this.validateCreateTargets({
      startedByWorkerId: dto.startedByWorkerId,
      classificationId: dto.classificationId,
      participantWorkerIds: dto.participantWorkerIds,
      requester: user,
      masterScopeToWorkerSite: true,
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.create({
        data: {
          startedByWorkerId: dto.startedByWorkerId,
          classificationId: dto.classificationId,
          volume: dto.volume ?? 0,
          quantity: dto.quantity ?? 0,
          startedAt,
          endedAt,
          status: 'ENDED',
          endedByWorkerId: user.sub,
          deviceId: 'web-manual',
          notes: `[수기등록] ${reason}`,
        },
      });

      // 시작 작업자를 STARTER로 배정
      await tx.workAssignment.create({
        data: {
          workItemId: item.id,
          workerId: dto.startedByWorkerId,
          role: 'STARTER',
        },
      });

      // 추가 참여자 배정
      for (const participantId of participantIds) {
        await tx.workAssignment.create({
          data: {
            workItemId: item.id,
            workerId: participantId,
            role: 'PARTICIPANT',
          },
        });
      }

      // 감사 로그 (수기 등록)
      await tx.auditLog.create({
        data: {
          actorWorkerId: user.sub,
          workItemId: item.id,
          action: 'MANUAL_CREATE',
          after: JSON.stringify(item),
          reason,
          ip,
          userAgent,
        },
      });

      return item;
    });

    this.logger.log(`WorkItem manually created: ${created.id} by ${user.sub}`);
    return this.findOneRaw(created.id);
  }

  /**
   * 관리자: 작업 상세 조회 (배정 + 감사 로그 포함)
   */
  async findOneForAdmin(id: string, requester?: JwtPayload) {
    await this.assertSiteOwnership(id, requester);
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: {
        classification: true,
        startedByWorker: { select: { id: true, name: true, employeeCode: true, role: true } },
        endedByWorker: { select: { id: true, name: true, employeeCode: true, role: true } },
        assignments: {
          include: { worker: { select: { id: true, name: true, employeeCode: true, role: true } } },
          orderBy: { addedAt: 'asc' },
        },
        auditLogs: {
          include: {
            actorWorker: { select: { id: true, name: true, employeeCode: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    return workItem;
  }

  /**
   * 관리자: 작업 수정 (사유 필수, 감사 로그 자동 생성)
   */
  async updateForAdmin(
    id: string,
    dto: UpdateWorkItemDto,
    actorWorkerId: string,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ) {
    await this.assertSiteOwnership(id, requester);
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });
    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    if (workItem.status === 'VOID') {
      throw new BadRequestException('무효화된 작업은 수정할 수 없습니다');
    }

    const beforeState = JSON.stringify(workItem);

    const updateData: Prisma.WorkItemUpdateInput = {};
    if (dto.classificationId !== undefined) {
      updateData.classification = { connect: { id: dto.classificationId } };
    }
    if (dto.volume !== undefined) {
      updateData.volume = dto.volume;
    }
    if (dto.quantity !== undefined) {
      updateData.quantity = dto.quantity;
    }
    if (dto.notes !== undefined) {
      updateData.notes = dto.notes;
    }
    // ★ 작업 시간 수정 (관리자 전용)
    if (dto.startedAt !== undefined) {
      updateData.startedAt = new Date(dto.startedAt);
    }
    if (dto.endedAt !== undefined) {
      updateData.endedAt = new Date(dto.endedAt);
    }
    // 시작 > 종료 검증 — 단일 필드 수정도 기존 값과 비교 (역전 방지)
    const effStart = dto.startedAt ? new Date(dto.startedAt) : workItem.startedAt;
    const effEnd = dto.endedAt
      ? new Date(dto.endedAt)
      : workItem.endedAt;
    if (effStart && effEnd && effStart > effEnd) {
      throw new BadRequestException('시작 시간이 종료 시간보다 늦을 수 없습니다');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: updateData,
      });

      await tx.auditLog.create({
        data: {
          actorWorkerId,
          workItemId: id,
          action: 'EDIT',
          before: beforeState,
          after: JSON.stringify(item),
          reason: dto.reason,
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneForAdmin(updated.id);
  }

  /**
   * 관리자: 작업 무효화 (사유 필수)
   */
  async voidWorkItem(
    id: string,
    dto: VoidWorkItemDto,
    actorWorkerId: string,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ) {
    await this.assertSiteOwnership(id, requester);
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });
    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    if (workItem.status === 'VOID') {
      throw new BadRequestException('이미 무효화된 작업입니다');
    }

    const beforeState = JSON.stringify(workItem);

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: { status: 'VOID' },
      });

      await tx.auditLog.create({
        data: {
          actorWorkerId,
          workItemId: id,
          action: 'VOID',
          before: beforeState,
          after: JSON.stringify(item),
          reason: dto.reason,
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneForAdmin(updated.id);
  }

  /**
   * 반장/관리자: 강제 종료 (미종료 작업에 대해)
   */
  async forceEnd(
    id: string,
    dto: ForceEndWorkItemDto,
    actorWorkerId: string,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ) {
    await this.assertSiteOwnership(id, requester);
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });
    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    if (workItem.status !== 'ACTIVE' && workItem.status !== 'PAUSED') {
      throw new BadRequestException('활성 또는 중간마감 상태의 작업만 강제 종료할 수 있습니다');
    }

    const beforeState = JSON.stringify(workItem);

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: {
          endedByWorkerId: actorWorkerId,
          endedAt: new Date(),
          status: 'ENDED',
          volume: dto.volume !== undefined ? dto.volume : workItem.volume,
          quantity: dto.quantity !== undefined ? dto.quantity : workItem.quantity,
        },
      });

      await tx.auditLog.create({
        data: {
          actorWorkerId,
          workItemId: id,
          action: 'END',
          before: beforeState,
          after: JSON.stringify(item),
          reason: `[강제종료] ${dto.reason}`,
          ip,
          userAgent,
        },
      });

      return item;
    });

    return this.findOneForAdmin(updated.id);
  }

  /**
   * 반장/관리자: 선택 작업 일괄 강제 종료.
   * 대상 전체의 소유권을 먼저 검증해 다른 사업장 작업이 섞인 요청은 변경 없이 차단한다.
   */
  async bulkForceEnd(
    dto: BulkWorkItemsDto,
    actorWorkerId: string,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ): Promise<{ done: string[]; skipped: Array<{ id: string; reason: string }> }> {
    await this.prevalidateBulkSiteOwnership(dto.ids, requester);

    const done: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of dto.ids) {
      try {
        await this.forceEnd(id, { reason: dto.reason }, actorWorkerId, ip, userAgent, requester);
        done.push(id);
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        if (error instanceof BadRequestException || error instanceof NotFoundException) {
          skipped.push({ id, reason: this.getBulkSkipReason(error) });
          continue;
        }
        throw error;
      }
    }

    return { done, skipped };
  }

  /**
   * 반장/관리자: 선택 작업 일괄 무효화. 삭제하지 않고 VOID 상태와 감사 로그를 남긴다.
   */
  async bulkVoid(
    dto: BulkWorkItemsDto,
    actorWorkerId: string,
    ip?: string,
    userAgent?: string,
    requester?: JwtPayload,
  ): Promise<{ done: string[]; skipped: Array<{ id: string; reason: string }> }> {
    await this.prevalidateBulkSiteOwnership(dto.ids, requester);

    const done: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of dto.ids) {
      try {
        await this.voidWorkItem(id, { reason: dto.reason }, actorWorkerId, ip, userAgent, requester);
        done.push(id);
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        if (error instanceof BadRequestException || error instanceof NotFoundException) {
          skipped.push({ id, reason: this.getBulkSkipReason(error) });
          continue;
        }
        throw error;
      }
    }

    return { done, skipped };
  }

  private async prevalidateBulkSiteOwnership(
    ids: string[],
    requester?: JwtPayload,
  ): Promise<void> {
    for (const id of ids) {
      try {
        await this.assertSiteOwnership(id, requester);
      } catch (error) {
        // 삭제 경쟁으로 사라진 항목은 처리 루프에서 skipped로 반환한다.
        // 다른 사업장 항목 등 나머지 오류는 어떤 변경도 하기 전에 요청 전체를 차단한다.
        if (error instanceof NotFoundException) continue;
        throw error;
      }
    }
  }

  private getBulkSkipReason(error: BadRequestException | NotFoundException): string {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown })?.message;
    if (Array.isArray(message)) return message.join(', ');
    return typeof message === 'string' ? message : error.message;
  }

  // ======================== Internal ========================

  /**
   * 관계 포함 원시 조회 (내부용)
   */
  private async findOneRaw(id: string) {
    return this.prisma.workItem.findUnique({
      where: { id },
      include: {
        classification: { select: { id: true, code: true, displayName: true } },
        startedByWorker: { select: { id: true, name: true, employeeCode: true } },
        endedByWorker: { select: { id: true, name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { id: true, name: true, employeeCode: true } } },
          orderBy: { addedAt: 'asc' },
        },
      },
    });
  }

  /**
   * 관리자: 작업 기록 영구 삭제
   * - 사업장 소유권 검증
   * - FK 제약 모두 해소: workAssignment + auditLog + inspectionRecord 먼저 삭제
   */
  async deleteWorkItem(id: string, requester?: JwtPayload): Promise<void> {
    await this.assertSiteOwnership(id, requester);
    const existing = await this.prisma.workItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('작업을 찾을 수 없습니다');

    await this.prisma.$transaction(async (tx) => {
      // FK 참조 모두 정리 후 work-item 삭제 (CLAUDE.md 함정 #18 패턴)
      await tx.workAssignment.deleteMany({ where: { workItemId: id } });
      await tx.auditLog.deleteMany({ where: { workItemId: id } });
      // inspectionRecord는 workItem FK가 있을 수 있음 (스키마에 의존)
      try {
        await (tx as any).inspectionRecord?.deleteMany?.({ where: { workItemId: id } });
      } catch {
        // 모델 없음 또는 FK 없음 — 무시
      }
      await tx.workItem.delete({ where: { id } });
    });

    this.logger.log(`WorkItem deleted: ${id}`);
  }

  /**
   * 작업 복원 (ENDED → ACTIVE)
   * 모바일에서 실수로 종료한 작업을 되돌리거나, 관리자가 잘못 종료된 작업을 되살릴 때 사용
   * - 종료 시각 NULL 처리, 상태 ACTIVE
   */
  async restoreWorkItem(id: string, requester?: JwtPayload, ip?: string, userAgent?: string) {
    await this.assertSiteOwnership(id, requester);
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });
    if (!workItem) throw new NotFoundException('작업을 찾을 수 없습니다');

    // 모바일 호출 시 소유권 추가 검증 (관리자는 위 assertSiteOwnership 통과)
    if (requester && requester.role === 'WORKER') {
      assertWorkItemOwnership({
        requesterId: requester.sub,
        requesterRole: requester.role,
        workItem,
      });
    }

    if (workItem.status !== 'ENDED') {
      throw new BadRequestException('종료된 작업만 복원할 수 있습니다');
    }

    const beforeState = JSON.stringify(workItem);
    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          endedAt: null,
          endedByWorkerId: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorWorkerId: requester?.sub ?? workItem.startedByWorkerId,
          workItemId: id,
          action: 'RESTORE',
          before: beforeState,
          after: JSON.stringify(item),
          reason: '작업 복원 (ENDED → ACTIVE)',
          ip,
          userAgent,
        },
      });
      return item;
    });

    return this.findOneRaw(updated.id);
  }

  /**
   * 모바일: 작업 무효화 (VOID)
   * 작업 시작자를 actor로 사용
   */
  async voidWorkItemFromMobile(id: string, ip?: string, userAgent?: string, requester?: JwtPayload) {
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });
    if (!workItem) throw new NotFoundException('작업을 찾을 수 없습니다');

    // P0-4: 소유자 검증 (모바일에서 타인의 작업 무효화 방지)
    if (requester) {
      assertWorkItemOwnership({
        requesterId: requester.sub,
        requesterRole: requester.role,
        workItem,
      });
    }

    if (workItem.status === 'VOID') throw new BadRequestException('이미 무효화된 작업입니다');

    const beforeState = JSON.stringify(workItem);
    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.workItem.update({
        where: { id },
        data: { status: 'VOID' },
      });
      await tx.auditLog.create({
        data: {
          actorWorkerId: workItem.startedByWorkerId,
          workItemId: id,
          action: 'VOID',
          before: beforeState,
          after: JSON.stringify(item),
          reason: '모바일 삭제 요청',
          ip,
          userAgent,
        },
      });
      return item;
    });
    return this.findOneRaw(updated.id);
  }
}
