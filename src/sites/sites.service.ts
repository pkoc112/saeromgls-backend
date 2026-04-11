import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 전체 사업장 목록 조회 (이름순 정렬)
   */
  async findAll() {
    const sites = await this.prisma.site.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { workers: true, childSites: true } },
        parentSite: { select: { id: true, name: true, code: true } },
      },
    });

    return sites.map((site) => ({
      ...site,
      workerCount: site._count.workers,
      childCount: site._count.childSites,
      _count: undefined,
    }));
  }

  /**
   * 소속 사업장만 조회 (ADMIN용)
   */
  async findBySiteId(siteId?: string) {
    if (!siteId) return [];
    // 소속 사업장 + 자식 사업장 모두 반환
    const sites = await this.prisma.site.findMany({
      where: { OR: [{ id: siteId }, { parentSiteId: siteId }] },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { workers: true, childSites: true } },
        parentSite: { select: { id: true, name: true, code: true } },
      },
    });
    return sites.map((site) => ({
      ...site,
      workerCount: site._count.workers,
      childCount: site._count.childSites,
      _count: undefined,
    }));
  }

  /**
   * 코드로 사업장 조회
   */
  async findByCode(code: string) {
    const site = await this.prisma.site.findUnique({
      where: { code },
    });

    if (!site) {
      throw new NotFoundException(`사업장을 찾을 수 없습니다 (code: ${code})`);
    }

    return site;
  }

  /**
   * 사업장 생성
   */
  async create(dto: CreateSiteDto) {
    // 코드 중복 검사
    const existing = await this.prisma.site.findUnique({
      where: { code: dto.code },
    });

    if (existing) {
      throw new ConflictException(
        `이미 존재하는 사업장 코드입니다: ${dto.code}`,
      );
    }

    // 부모 사업장 검증
    if (dto.parentSiteId) {
      const parent = await this.prisma.site.findUnique({ where: { id: dto.parentSiteId } });
      if (!parent) throw new NotFoundException('상위 사업장을 찾을 수 없습니다');
      if (!parent.isActive) throw new BadRequestException('비활성 사업장 아래에 생성할 수 없습니다');
    }

    const site = await this.prisma.site.create({
      data: {
        name: dto.name,
        code: dto.code,
        parentSiteId: dto.parentSiteId ?? null,
      },
    });

    this.logger.log(`Site created: ${site.name} (${site.code})`);
    return site;
  }

  /**
   * 사업장 수정
   */
  async update(id: string, dto: UpdateSiteDto) {
    const existing = await this.prisma.site.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('사업장을 찾을 수 없습니다');
    }

    // 코드 변경 시 중복 검사
    if (dto.code && dto.code !== existing.code) {
      const codeExists = await this.prisma.site.findUnique({
        where: { code: dto.code },
      });
      if (codeExists) {
        throw new ConflictException(
          `이미 존재하는 사업장 코드입니다: ${dto.code}`,
        );
      }
    }

    const site = await this.prisma.site.update({
      where: { id },
      data: dto,
    });

    this.logger.log(`Site updated: ${site.name} (${site.code})`);
    return site;
  }

  /**
   * 사업장 활성/비활성 토글
   */
  async toggleActive(id: string) {
    const existing = await this.prisma.site.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('사업장을 찾을 수 없습니다');

    const site = await this.prisma.site.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });

    this.logger.log(`Site ${site.isActive ? 'activated' : 'deactivated'}: ${site.name}`);
    return site;
  }

  /**
   * 사업장 영구 삭제
   * 소속 작업자가 있으면 삭제 불가
   */
  async remove(id: string) {
    const existing = await this.prisma.site.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('사업장을 찾을 수 없습니다');

    if (existing.code === 'DEFAULT') {
      throw new BadRequestException('DEFAULT 사업장은 삭제할 수 없습니다');
    }

    const childCount = await this.prisma.site.count({ where: { parentSiteId: id } });
    if (childCount > 0) {
      throw new ConflictException(`하위 사업장이 ${childCount}개 있어 삭제할 수 없습니다. 먼저 하위 사업장을 삭제하세요.`);
    }

    const workerCount = await this.prisma.worker.count({ where: { siteId: id } });
    if (workerCount > 0) {
      throw new ConflictException(`소속 작업자가 ${workerCount}명 있어 삭제할 수 없습니다. 먼저 작업자를 다른 사업장으로 이관하세요.`);
    }

    await this.prisma.site.delete({ where: { id } });
    this.logger.log(`Site deleted: ${existing.name} (${existing.code})`);
  }

  /**
   * 기존 작업자를 대상 사업장으로 일괄 이관
   * siteId가 null이거나 DEFAULT 사업장인 작업자를 대상 사업장으로 이동
   */
  async migrateWorkersToSite(targetSiteId: string) {
    const targetSite = await this.prisma.site.findUnique({
      where: { id: targetSiteId },
    });
    if (!targetSite) {
      throw new NotFoundException('대상 사업장을 찾을 수 없습니다');
    }

    // DEFAULT 사업장 ID 조회
    const defaultSite = await this.prisma.site.findUnique({
      where: { code: 'DEFAULT' },
    });

    // siteId가 null이거나 DEFAULT인 작업자를 대상 사업장으로 이관
    const result = await this.prisma.worker.updateMany({
      where: {
        OR: [
          { siteId: null },
          ...(defaultSite ? [{ siteId: defaultSite.id }] : []),
        ],
      },
      data: { siteId: targetSiteId },
    });

    // 휴게시간 설정도 이관 (siteId=null인 것들)
    const breakResult = await this.prisma.breakConfig.updateMany({
      where: { siteId: null },
      data: { siteId: targetSiteId },
    });

    this.logger.log(
      `Migrated ${result.count} workers + ${breakResult.count} break configs to site ${targetSite.name} (${targetSite.code})`,
    );

    return {
      message: `${targetSite.name}(${targetSite.code})으로 이관 완료`,
      migratedWorkers: result.count,
      migratedBreakConfigs: breakResult.count,
    };
  }

  /**
   * 사업장 코드 유효성 검증 (회원가입 폼 검증용)
   */
  async verifyCode(code: string): Promise<{ valid: boolean; name: string }> {
    const site = await this.prisma.site.findUnique({
      where: { code },
    });

    if (!site || !site.isActive) {
      return { valid: false, name: '' };
    }

    return { valid: true, name: site.name };
  }
}
