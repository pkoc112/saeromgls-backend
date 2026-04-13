import {
  Injectable,
  ConflictException,
  NotFoundException,
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
   * 분류 수정 (관리자 전용)
   */
  async update(id: string, dto: UpdateClassificationDto) {
    const existing = await this.prisma.classification.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('분류를 찾을 수 없습니다');
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
