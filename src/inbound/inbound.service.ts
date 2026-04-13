import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';
import { CreateInboundSessionDto } from './dto/create-inbound-session.dto';
import { QueryInboundDto } from './dto/query-inbound.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 입고 세션 목록 조회 (페이지네이션, 필터)
   */
  async findAll(siteId: string | undefined, params: QueryInboundDto) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.InboundSessionWhereInput = {};

    if (siteId) {
      where.siteId = siteId;
    }

    if (params.status) {
      where.status = params.status;
    }

    if (params.from || params.to) {
      where.sessionDate = {};
      if (params.from) {
        where.sessionDate.gte = kstStartOfDay(params.from);
      }
      if (params.to) {
        where.sessionDate.lte = kstEndOfDay(params.to);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.inboundSession.findMany({
        where,
        include: {
          approvedBy: { select: { id: true, name: true, employeeCode: true } },
          participants: {
            include: { worker: { select: { id: true, name: true, employeeCode: true } } },
          },
        },
        orderBy: { sessionDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inboundSession.count({ where }),
    ]);

    return {
      data: data.map((s) => ({
        ...s,
        totalVolume: Number(s.totalVolume),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 입고 세션 생성 (수동)
   */
  async create(dto: CreateInboundSessionDto, siteId: string) {
    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inboundSession.create({
        data: {
          siteId,
          sessionDate: new Date(dto.sessionDate),
          shift: dto.shift || 'AM',
          supplierName: dto.supplierName,
          totalQuantity: dto.totalQuantity ?? 0,
          totalVolume: dto.totalVolume ?? 0,
          itemCount: dto.itemCount ?? 0,
          notes: dto.notes,
          status: 'PENDING',
        },
      });

      // 참여자 등록
      if (dto.participantWorkerIds && dto.participantWorkerIds.length > 0) {
        const uniqueIds = [...new Set(dto.participantWorkerIds)];
        for (const workerId of uniqueIds) {
          await tx.inboundParticipant.create({
            data: {
              inboundSessionId: created.id,
              workerId,
            },
          });
        }
      }

      return created;
    });

    this.logger.log(`InboundSession created: ${session.id}`);
    return this.findOneRaw(session.id);
  }

  /**
   * 입고 세션 승인
   */
  async approve(id: string, approvedByWorkerId: string) {
    const session = await this.prisma.inboundSession.findUnique({ where: { id } });
    if (!session) {
      throw new NotFoundException('입고 세션을 찾을 수 없습니다');
    }
    if (session.status !== 'PENDING') {
      throw new BadRequestException('대기 상태의 세션만 승인할 수 있습니다');
    }

    const updated = await this.prisma.inboundSession.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedByWorkerId,
        approvedAt: new Date(),
      },
    });

    this.logger.log(`InboundSession approved: ${id} by ${approvedByWorkerId}`);
    return this.findOneRaw(updated.id);
  }

  /**
   * 입고 세션 반려
   */
  async reject(id: string, reason: string) {
    const session = await this.prisma.inboundSession.findUnique({ where: { id } });
    if (!session) {
      throw new NotFoundException('입고 세션을 찾을 수 없습니다');
    }
    if (session.status !== 'PENDING') {
      throw new BadRequestException('대기 상태의 세션만 반려할 수 있습니다');
    }

    const updated = await this.prisma.inboundSession.update({
      where: { id },
      data: {
        status: 'REJECTED',
        notes: reason ? `[반려 사유] ${reason}${session.notes ? '\n' + session.notes : ''}` : session.notes,
      },
    });

    this.logger.log(`InboundSession rejected: ${id}`);
    return this.findOneRaw(updated.id);
  }

  /**
   * 엑셀 업로드로 입고 세션 생성
   * fileData: 파싱된 엑셀 데이터 (JSON)
   */
  async uploadExcel(siteId: string, fileData: any, approvedByWorkerId: string) {
    const {
      sessionDate,
      shift,
      supplierName,
      totalQuantity,
      totalVolume,
      itemCount,
      expectedQuantity,
      diffQuantity,
      items,
    } = fileData;

    if (!sessionDate) {
      throw new BadRequestException('엑셀 데이터에 입고 날짜가 없습니다');
    }

    const parsedDate = new Date(sessionDate);
    const dayStart = new Date(parsedDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(parsedDate);
    dayEnd.setHours(23, 59, 59, 999);

    // 중복 체크: 같은 날짜 + 공급처 + 수량 → 덮어쓰기
    const existing = await this.prisma.inboundSession.findFirst({
      where: {
        siteId,
        supplierName: supplierName || null,
        totalQuantity: Number(totalQuantity) || 0,
        sessionDate: { gte: dayStart, lte: dayEnd },
      },
    });

    if (existing) {
      // 기존 세션 삭제 (참여자도 cascade 삭제)
      await this.prisma.inboundSession.delete({ where: { id: existing.id } });
      this.logger.log(`Duplicate inbound session deleted: ${existing.id} (${supplierName}, ${totalQuantity})`);
    }

    const session = await this.prisma.inboundSession.create({
      data: {
        siteId,
        sessionDate: parsedDate,
        shift: shift || 'FULL',
        supplierName: supplierName || null,
        totalQuantity: Number(totalQuantity) || 0,
        totalVolume: Number(totalVolume) || 0,
        itemCount: Number(itemCount) || 0,
        expectedQuantity: Number(expectedQuantity) || 0,
        diffQuantity: Number(diffQuantity) || 0,
        rawData: JSON.stringify(items || fileData),
        status: 'PENDING',
        notes: existing ? '엑셀 업로드 (덮어쓰기)' : '엑셀 업로드로 생성',
      },
    });

    this.logger.log(
      `InboundSession ${existing ? 'overwritten' : 'created'} from Excel: ${session.id} (${supplierName})`,
    );
    return this.findOneRaw(session.id);
  }

  /**
   * 내부: 관계 포함 단건 조회
   */
  private async findOneRaw(id: string) {
    const session = await this.prisma.inboundSession.findUnique({
      where: { id },
      include: {
        approvedBy: { select: { id: true, name: true, employeeCode: true } },
        participants: {
          include: { worker: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
    });

    if (!session) return null;

    return {
      ...session,
      totalVolume: Number(session.totalVolume),
    };
  }
}
