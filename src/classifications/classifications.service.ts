import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClassificationDto } from './dto/create-classification.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';

@Injectable()
export class ClassificationsService {
  private readonly logger = new Logger(ClassificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관리자용: 분류 목록 (사업장 격리)
   * siteId가 있으면 해당 사업장 + siteId=null 분류 모두 반환
   */
  async findAll(siteId?: string) {
    const where = siteId
      ? { OR: [{ siteId }, { siteId: null }] }
      : {};

    return this.prisma.classification.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * 모바일용: 활성 분류 (사업장 격리)
   * siteId가 있으면 해당 사업장 + siteId=null 분류만 반환
   */
  async findActiveForMobile(siteId?: string) {
    const where: Record<string, unknown> = { isActive: true };

    if (siteId) {
      where.OR = [{ siteId }, { siteId: null }];
    }

    return this.prisma.classification.findMany({
      where,
      select: {
        id: true,
        code: true,
        displayName: true,
        sortOrder: true,
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * 분류 생성 (관리자 전용, 사업장 배정)
   */
  async create(dto: CreateClassificationDto, siteId?: string) {
    // 코드 중복 확인
    const existing = await this.prisma.classification.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(`분류 코드 '${dto.code}'은(는) 이미 존재합니다`);
    }

    const classification = await this.prisma.classification.create({
      data: {
        code: dto.code,
        displayName: dto.displayName,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        ...(siteId && { siteId }),
      },
    });

    this.logger.log(`Classification created: ${classification.code} (site: ${siteId || 'global'})`);
    return classification;
  }

  /**
   * 분류 수정 (관리자 전용) — 소유권 검증 포함
   *
   * - MASTER: 모든 분류 수정 가능 (전역 포함)
   * - ADMIN: 자기 사업장(siteId 일치)의 분류만 수정 가능
   *   · 전역 분류(siteId=null)는 MASTER만 관리해야 함 → ADMIN은 거부
   *   · 다른 사업장 분류도 거부
   */
  async update(
    id: string,
    dto: UpdateClassificationDto,
    requester?: { role: string; siteId?: string },
  ) {
    const existing = await this.prisma.classification.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('분류를 찾을 수 없습니다');
    }

    // ★ 소유권 검증 — MASTER 외에는 자기 사업장 분류만 수정 가능
    if (requester && requester.role !== 'MASTER') {
      if (existing.siteId === null) {
        throw new ForbiddenException('전역 분류는 MASTER만 수정할 수 있습니다');
      }
      if (existing.siteId !== requester.siteId) {
        throw new ForbiddenException('다른 사업장의 분류는 수정할 수 없습니다');
      }
    }

    // 코드 변경 시 중복 확인
    if (dto.code && dto.code !== existing.code) {
      const duplicate = await this.prisma.classification.findUnique({
        where: { code: dto.code },
      });
      if (duplicate) {
        throw new ConflictException(`분류 코드 '${dto.code}'은(는) 이미 존재합니다`);
      }
    }

    const classification = await this.prisma.classification.update({
      where: { id },
      data: dto,
    });

    this.logger.log(`Classification updated: ${classification.code}`);
    return classification;
  }
}
