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
   * 관리자용: 모든 분류 목록 조회
   */
  async findAll() {
    return this.prisma.classification.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * 모바일용: 활성 분류만 조회 (정렬 순서대로)
   */
  async findActiveForMobile() {
    return this.prisma.classification.findMany({
      where: { isActive: true },
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
   * 분류 생성 (관리자 전용)
   */
  async create(dto: CreateClassificationDto) {
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
      },
    });

    this.logger.log(`Classification created: ${classification.code}`);
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
