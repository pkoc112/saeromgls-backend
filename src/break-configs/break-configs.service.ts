import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBreakConfigDto } from './dto/create-break-config.dto';
import { UpdateBreakConfigDto } from './dto/update-break-config.dto';

@Injectable()
export class BreakConfigsService {
  private readonly logger = new Logger(BreakConfigsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관리자용: 휴게시간 설정 목록 조회
   * siteId가 있으면 해당 현장 설정을 먼저 조회, 없으면 전역 설정으로 fallback
   */
  async findAll(siteId?: string) {
    // 관리자용: 활성+비활성 모두 반환
    let data;
    if (siteId) {
      const siteConfigs = await this.prisma.breakConfig.findMany({
        where: { siteId },
        orderBy: { sortOrder: 'asc' },
      });
      if (siteConfigs.length > 0) {
        data = siteConfigs;
      }
    }

    if (!data) {
      // siteId 미지정 시 전체 반환 (관리자가 모든 설정을 볼 수 있도록)
      data = await this.prisma.breakConfig.findMany({
        orderBy: { sortOrder: 'asc' },
      });
    }

    return {
      data,
      meta: { total: data.length },
    };
  }

  /**
   * 모바일용: 활성 휴게시간 설정 (간소화)
   * siteId별 설정이 있으면 우선, 없으면 전역(siteId=null) fallback
   */
  async findForMobile(siteId?: string) {
    // 사업장별 설정 우선 조회
    if (siteId) {
      const siteConfigs = await this.prisma.breakConfig.findMany({
        where: { siteId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { startHour: true, startMin: true, endHour: true, endMin: true, label: true },
      });
      if (siteConfigs.length > 0) return siteConfigs;
    }

    // 전역 설정 fallback (siteId=null인 전역 설정만)
    return this.prisma.breakConfig.findMany({
      where: { isActive: true, siteId: null },
      orderBy: { sortOrder: 'asc' },
      select: { startHour: true, startMin: true, endHour: true, endMin: true, label: true },
    });
  }

  /**
   * 휴게시간 설정 생성
   */
  async create(dto: CreateBreakConfigDto) {
    await this.validateTimeRange(dto);
    await this.validateNoOverlap(dto);
    await this.validateMaxCount(dto.siteId ?? null);

    // sortOrder 자동 부여
    const maxSort = await this.prisma.breakConfig.aggregate({
      _max: { sortOrder: true },
      where: { siteId: dto.siteId ?? null, isActive: true },
    });
    const nextSort = (maxSort._max.sortOrder ?? 0) + 1;

    const config = await this.prisma.breakConfig.create({
      data: {
        label: dto.label,
        startHour: dto.startHour,
        startMin: dto.startMin,
        endHour: dto.endHour,
        endMin: dto.endMin,
        siteId: dto.siteId ?? null,
        sortOrder: nextSort,
      },
    });

    this.logger.log(`BreakConfig created: ${config.label} (${config.id})`);
    return config;
  }

  /**
   * 휴게시간 설정 수정
   */
  async update(id: string, dto: UpdateBreakConfigDto) {
    const existing = await this.prisma.breakConfig.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('휴게시간 설정을 찾을 수 없습니다');
    }

    // 시간 관련 필드가 변경되는 경우에만 유효성 검사
    const merged = {
      startHour: dto.startHour ?? existing.startHour,
      startMin: dto.startMin ?? existing.startMin,
      endHour: dto.endHour ?? existing.endHour,
      endMin: dto.endMin ?? existing.endMin,
      siteId: (dto.siteId ?? existing.siteId) || undefined,
    };

    const timeChanged =
      dto.startHour !== undefined ||
      dto.startMin !== undefined ||
      dto.endHour !== undefined ||
      dto.endMin !== undefined;

    if (timeChanged) {
      await this.validateTimeRange(merged);
      await this.validateNoOverlap(merged, id);
    }

    const config = await this.prisma.breakConfig.update({
      where: { id },
      data: dto,
    });

    this.logger.log(`BreakConfig updated: ${config.label} (${config.id})`);
    return config;
  }

  /**
   * 휴게시간 설정 비활성화 (소프트 삭제)
   */
  async remove(id: string) {
    const existing = await this.prisma.breakConfig.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('휴게시간 설정을 찾을 수 없습니다');
    }

    await this.prisma.breakConfig.delete({
      where: { id },
    });

    this.logger.log(`BreakConfig deleted: ${existing.label} (${id})`);
  }

  // ===================== Validation Helpers =====================

  private async validateTimeRange(dto: {
    startHour: number;
    startMin: number;
    endHour: number;
    endMin: number;
  }) {
    const newStart = dto.startHour * 60 + dto.startMin;
    const newEnd = dto.endHour * 60 + dto.endMin;

    if (newEnd <= newStart) {
      throw new BadRequestException('종료 시간은 시작 시간 이후여야 합니다');
    }

    if (newEnd - newStart < 5) {
      throw new BadRequestException('최소 5분 이상이어야 합니다');
    }
  }

  private async validateNoOverlap(
    dto: {
      startHour: number;
      startMin: number;
      endHour: number;
      endMin: number;
      siteId?: string;
    },
    excludeId?: string,
  ) {
    const newStart = dto.startHour * 60 + dto.startMin;
    const newEnd = dto.endHour * 60 + dto.endMin;

    const existing = await this.prisma.breakConfig.findMany({
      where: { siteId: dto.siteId ?? null },
    });

    for (const b of existing) {
      if (excludeId && b.id === excludeId) continue;
      const s = b.startHour * 60 + b.startMin;
      const e = b.endHour * 60 + b.endMin;
      if (newStart < e && newEnd > s) {
        const fmt = (h: number, m: number) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        throw new ConflictException(`이미 같은 시간대가 존재합니다 (${b.label}: ${fmt(b.startHour,b.startMin)}~${fmt(b.endHour,b.endMin)})`);
      }
    }
  }

  private async validateMaxCount(siteId: string | null) {
    const count = await this.prisma.breakConfig.count({
      where: { isActive: true, siteId },
    });

    if (count >= 10) {
      throw new BadRequestException(
        '휴게시간 설정은 최대 10개까지 가능합니다',
      );
    }
  }
}
