import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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
import { Prisma } from '@prisma/client';

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
  async create(dto: CreateWorkItemDto, ip?: string, userAgent?: string) {
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

    // 작업자 존재 확인
    const worker = await this.prisma.worker.findUnique({
      where: { id: dto.startedByWorkerId },
    });
    if (!worker || worker.status !== 'ACTIVE') {
      throw new BadRequestException('유효하지 않은 작업자입니다');
    }

    // 분류 존재 확인
    const classification = await this.prisma.classification.findUnique({
      where: { id: dto.classificationId },
    });
    if (!classification || !classification.isActive) {
      throw new BadRequestException('유효하지 않은 분류입니다');
    }

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

      // 추가 참여자 배정
      if (dto.participantWorkerIds && dto.participantWorkerIds.length > 0) {
        const uniqueParticipants = dto.participantWorkerIds.filter(
          (id) => id !== dto.startedByWorkerId,
        );
        for (const participantId of uniqueParticipants) {
          await tx.workAssignment.create({
            data: {
              workItemId: item.id,
              workerId: participantId,
              role: 'PARTICIPANT',
            },
          });
        }
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
   * 모바일: 작업 목록 조회
   * status 파라미터로 쉼표 구분 다중 상태 필터 가능 (예: "ACTIVE,PAUSED")
   * 기본값은 ACTIVE
   */
  async findActiveForMobile(workerId?: string, statusFilter?: string, siteId?: string) {
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

    return this.prisma.workItem.findMany({
      where,
      include: {
        classification: { select: { id: true, code: true, displayName: true } },
        startedByWorker: { select: { id: true, name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
      orderBy: { startedAt: 'desc' },
      take: 200, // 무제한 방지
    });
  }

  /**
   * 모바일: 작업 종료
   * 종료 시 물량/수량 확정, 추가 참여자 등록 가능
   */
  async endWorkItem(id: string, dto: EndWorkItemDto, ip?: string, userAgent?: string) {
    const workItem = await this.prisma.workItem.findUnique({
      where: { id },
      include: { assignments: true },
    });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    }

    if (workItem.status !== 'ACTIVE' && workItem.status !== 'PAUSED') {
      throw new BadRequestException('이미 종료되었거나 무효화된 작업입니다');
    }

    const beforeState = JSON.stringify(workItem);

    const updated = await this.prisma.$transaction(async (tx) => {
      // 작업 종료 처리
      const item = await tx.workItem.update({
        where: { id },
        data: {
          endedByWorkerId: dto.endedByWorkerId,
          endedAt: new Date(),
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
  async pauseWorkItem(id: string, dto: PauseWorkItemDto, ip?: string, userAgent?: string) {
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
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
  async resumeWorkItem(id: string, resumedByWorkerId: string, ip?: string, userAgent?: string) {
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });

    if (!workItem) {
      throw new NotFoundException('작업을 찾을 수 없습니다');
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
   * 관리자: 작업 목록 조회 (페이지네이션, 필터)
   */
  async findAllForAdmin(query: QueryWorkItemsDto, siteId?: string) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

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

    if (query.workerId) {
      where.OR = [
        { startedByWorkerId: query.workerId },
        { assignments: { some: { workerId: query.workerId } } },
      ];
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

    const [data, total] = await Promise.all([
      this.prisma.workItem.findMany({
        where,
        include: {
          classification: { select: { id: true, code: true, displayName: true } },
          startedByWorker: { select: { id: true, name: true, employeeCode: true } },
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

    const enriched = data.map((d) => {
      const adj = batchMap.get(d.id);
      return {
        ...d,
        adjustedMinutes: adj?.adjustedMinutes ?? null,
        rawMinutes: adj?.rawMinutes ?? null,
        concurrentCount: adj?.concurrentCount ?? 1,
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
   * 관리자: 작업 상세 조회 (배정 + 감사 로그 포함)
   */
  async findOneForAdmin(id: string) {
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
  ) {
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
    // 시작 > 종료 검증
    if (dto.startedAt && dto.endedAt) {
      if (new Date(dto.startedAt) > new Date(dto.endedAt)) {
        throw new BadRequestException('시작 시간이 종료 시간보다 늦을 수 없습니다');
      }
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
  ) {
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
  ) {
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
   */
  async deleteWorkItem(id: string): Promise<void> {
    const existing = await this.prisma.workItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('작업을 찾을 수 없습니다');

    await this.prisma.$transaction(async (tx) => {
      await tx.workAssignment.deleteMany({ where: { workItemId: id } });
      await tx.workItem.delete({ where: { id } });
    });

    this.logger.log(`WorkItem deleted: ${id}`);
  }

  /**
   * 모바일: 작업 무효화 (VOID)
   * 작업 시작자를 actor로 사용
   */
  async voidWorkItemFromMobile(id: string, ip?: string, userAgent?: string) {
    const workItem = await this.prisma.workItem.findUnique({ where: { id } });
    if (!workItem) throw new NotFoundException('작업을 찾을 수 없습니다');
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
