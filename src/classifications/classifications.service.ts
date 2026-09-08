import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClassificationDto } from './dto/create-classification.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';
import { ReorderClassificationsDto } from './dto/reorder-classifications.dto';
import { compareClassifications } from './classification-order';
import { resolveSiteId } from '../common/utils/site-scope';
import { JwtPayload } from '../common/decorators/current-user.decorator';

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

    const list = await this.prisma.classification.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
    });
    return list.sort(compareClassifications);
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

    const [list, modes] = await Promise.all([
      this.prisma.classification.findMany({
        where,
        select: {
          id: true,
          code: true,
          displayName: true,
          sortOrder: true,
          siteId: true,
        },
        orderBy: { sortOrder: 'asc' },
      }),
      this.getClassificationModes(siteId),
    ]);

    // 분류(카테고리)별 입력모드 부여 — 항목 코드 접두사(카테고리코드)로 매핑.
    // 미설정 시: 쿠팡(COUPANG)은 기존 동작대로 '수량만', 그 외는 '둘 다'.
    return list.sort(compareClassifications).map((c) => {
      const categoryCode = c.code.includes('_') ? c.code.split('_')[0] : c.code;
      const fallback = categoryCode === 'COUPANG' ? 'QUANTITY' : 'BOTH';
      return { ...c, inputMode: modes[categoryCode] || fallback };
    });
  }

  async reorder(dto: ReorderClassificationsDto, user: JwtPayload) {
    const isMaster = user.role?.toLowerCase() === 'master';
    if (!isMaster && user.role?.toLowerCase() !== 'admin') {
      throw new ForbiddenException('납품처 순서는 관리자만 변경할 수 있습니다');
    }
    const scopedSite = resolveSiteId({ ...user, role: isMaster ? 'MASTER' : 'ADMIN' }, dto.siteId);
    if (dto.global && (!isMaster || dto.siteId)) {
      throw new ForbiddenException('공통 납품처는 MASTER가 공통 범위에서만 변경할 수 있습니다');
    }
    const siteId = dto.global ? null : scopedSite;
    if (siteId === undefined) {
      throw new BadRequestException('순서를 변경할 사업장을 선택하세요');
    }
    try {
      // Serializable plus the displayed order prevents partial writes and stale-list overwrites.
      return await this.prisma.$transaction(async (tx) => {
        const siblings = (await tx.classification.findMany({
          where: { siteId, isActive: true, code: { startsWith: `${dto.categoryCode}_` } },
        })).filter((item) => item.code.startsWith(`${dto.categoryCode}_`)).sort(compareClassifications);
        const currentIds = siblings.map((item) => item.id);
        if (currentIds.length !== dto.expectedIds.length
          || currentIds.some((id, index) => id !== dto.expectedIds[index])) {
          throw new ConflictException('납품처 목록이 변경되었습니다. 새로 조회한 후 다시 이동하세요');
        }
        if (dto.ids.length !== currentIds.length || new Set(dto.ids).size !== currentIds.length
          || dto.ids.some((id) => !currentIds.includes(id))) {
          throw new BadRequestException('같은 사업장과 분류의 납품처 전체 순서를 전달해야 합니다');
        }
        const byId = new Map(siblings.map((item) => [item.id, item]));
        for (const [sortOrder, id] of dto.ids.entries()) {
          if (byId.get(id)!.sortOrder !== sortOrder) {
            await tx.classification.update({ where: { id }, data: { sortOrder } });
          }
        }
        return { ids: dto.ids, siteId, categoryCode: dto.categoryCode };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('다른 관리자가 순서를 변경했습니다. 새로 조회한 후 다시 이동하세요');
      }
      throw error;
    }
  }

  /** 분류(카테고리)별 입력모드 맵 (TenantSettings JSON의 classificationModes). 없으면 {}. */
  private async getClassificationModes(siteId?: string): Promise<Record<string, string>> {
    if (!siteId) return {};
    try {
      const ts = await this.prisma.tenantSettings.findFirst({
        where: { siteId },
        select: { settings: true },
      });
      if (!ts?.settings) return {};
      const parsed = JSON.parse(ts.settings);
      return parsed?.classificationModes && typeof parsed.classificationModes === 'object'
        ? (parsed.classificationModes as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * 분류 생성 (관리자 전용, 사업장 배정)
   */
  async create(dto: CreateClassificationDto, siteId?: string) {
    // 코드 중복 확인 — ★ 같은 사업장(siteId) 안에서만 검사 (전역 unique 아님).
    //   다른 센터가 같은 code(COUPANG 등)를 쓰는 건 허용.
    const existing = await this.prisma.classification.findFirst({
      where: { code: dto.code, siteId: siteId ?? null },
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

    // 코드 변경 시 중복 확인 — ★ 같은 사업장(existing.siteId) 안에서만, 자기 자신 제외
    if (dto.code && dto.code !== existing.code) {
      const duplicate = await this.prisma.classification.findFirst({
        where: { code: dto.code, siteId: existing.siteId, id: { not: id } },
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
