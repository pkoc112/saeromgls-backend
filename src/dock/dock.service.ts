import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';
import { CreateDockSessionDto } from './dto/create-dock-session.dto';
import { EndDockSessionDto } from './dto/end-dock-session.dto';
import { QueryDockDto } from './dto/query-dock.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class DockService {
  private readonly logger = new Logger(DockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 도크 세션 목록 조회 (페이지네이션, 필터)
   */
  async findAll(siteId: string | undefined, params: QueryDockDto) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.DockSessionWhereInput = {};

    if (siteId) {
      where.siteId = siteId;
    }

    if (params.status) {
      where.status = params.status;
    }

    if (params.actionType) {
      where.actionType = params.actionType;
    }

    if (params.from || params.to) {
      where.startedAt = {};
      if (params.from) {
        where.startedAt.gte = kstStartOfDay(params.from);
      }
      if (params.to) {
        where.startedAt.lte = kstEndOfDay(params.to);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.dockSession.findMany({
        where,
        include: {
          startedBy: { select: { id: true, name: true, employeeCode: true } },
          participants: {
            include: { worker: { select: { id: true, name: true, employeeCode: true } } },
          },
        },
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.dockSession.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 도크 세션 시작
   */
  async create(dto: CreateDockSessionDto, siteId: string, startedByWorkerId: string) {
    // 작업자 확인
    const worker = await this.prisma.worker.findUnique({
      where: { id: startedByWorkerId },
    });
    if (!worker || worker.status !== 'ACTIVE') {
      throw new BadRequestException('유효하지 않은 작업자입니다');
    }

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dockSession.create({
        data: {
          siteId,
          actionType: dto.actionType,
          dockNumber: dto.dockNumber,
          vehicleNumber: dto.vehicleNumber,
          startedByWorkerId,
          status: 'ACTIVE',
        },
      });

      // 참여자 등록 (시작자 포함)
      await tx.dockParticipant.create({
        data: {
          dockSessionId: created.id,
          workerId: startedByWorkerId,
          role: 'WORKER',
        },
      });

      if (dto.participantWorkerIds && dto.participantWorkerIds.length > 0) {
        const uniqueIds = [...new Set(dto.participantWorkerIds)].filter(
          (id) => id !== startedByWorkerId,
        );
        for (const workerId of uniqueIds) {
          await tx.dockParticipant.create({
            data: {
              dockSessionId: created.id,
              workerId,
              role: 'WORKER',
            },
          });
        }
      }

      return created;
    });

    this.logger.log(`DockSession created: ${session.id} (${dto.actionType})`);
    return this.findOneRaw(session.id);
  }

  /**
   * 도크 세션 종료
   */
  async end(id: string, dto: EndDockSessionDto) {
    const session = await this.prisma.dockSession.findUnique({ where: { id } });
    if (!session) {
      throw new NotFoundException('도크 세션을 찾을 수 없습니다');
    }
    if (session.status !== 'ACTIVE') {
      throw new BadRequestException('활성 상태의 세션만 종료할 수 있습니다');
    }

    const updated = await this.prisma.dockSession.update({
      where: { id },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        totalQuantity: dto.totalQuantity ?? 0,
        wrapIncluded: dto.wrapIncluded ?? false,
        wrapLevel: dto.wrapLevel,
        notes: dto.notes,
      },
    });

    this.logger.log(`DockSession ended: ${id}`);
    return this.findOneRaw(updated.id);
  }

  /**
   * 도크 통계: 기간별 세션 수, 상하차 비율, 평균 소요시간
   */
  async getStats(siteId: string | undefined, from?: string, to?: string) {
    const where: Prisma.DockSessionWhereInput = {};

    if (siteId) {
      where.siteId = siteId;
    }

    if (from || to) {
      where.startedAt = {};
      if (from) {
        where.startedAt.gte = kstStartOfDay(from);
      }
      if (to) {
        where.startedAt.lte = kstEndOfDay(to);
      }
    }

    const [
      totalSessions,
      activeSessions,
      endedSessions,
      loadSessions,
      unloadSessions,
      wrapSessions,
    ] = await Promise.all([
      this.prisma.dockSession.count({ where }),
      this.prisma.dockSession.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.dockSession.count({ where: { ...where, status: 'ENDED' } }),
      this.prisma.dockSession.count({ where: { ...where, actionType: 'LOAD' } }),
      this.prisma.dockSession.count({ where: { ...where, actionType: 'UNLOAD' } }),
      this.prisma.dockSession.count({ where: { ...where, wrapIncluded: true } }),
    ]);

    // 평균 소요시간 (종료된 세션만)
    const endedWithTime = await this.prisma.dockSession.findMany({
      where: { ...where, status: 'ENDED', endedAt: { not: null } },
      select: { startedAt: true, endedAt: true },
    });

    let avgDurationMinutes = 0;
    if (endedWithTime.length > 0) {
      const totalMs = endedWithTime.reduce((sum, s) => {
        if (s.endedAt) {
          return sum + (s.endedAt.getTime() - s.startedAt.getTime());
        }
        return sum;
      }, 0);
      avgDurationMinutes = Number((totalMs / endedWithTime.length / 60000).toFixed(1));
    }

    return {
      totalSessions,
      activeSessions,
      endedSessions,
      byActionType: {
        load: loadSessions,
        unload: unloadSessions,
      },
      wrapSessions,
      avgDurationMinutes,
    };
  }

  /**
   * 내부: 관계 포함 단건 조회
   */
  private async findOneRaw(id: string) {
    return this.prisma.dockSession.findUnique({
      where: { id },
      include: {
        startedBy: { select: { id: true, name: true, employeeCode: true } },
        participants: {
          include: { worker: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
    });
  }
}
