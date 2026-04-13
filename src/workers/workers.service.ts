import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkerDto } from './dto/create-worker.dto';
import { UpdateWorkerDto } from './dto/update-worker.dto';

/** 관리 역할 — 작업자 목록에서 제외 */
const MANAGEMENT_ROLES = ['MASTER', 'ADMIN'] as const;

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관리자용: 작업자 목록 조회 (페이지네이션, 상태/사업장 필터)
   */
  async findAll(params: {
    page?: number;
    limit?: number;
    status?: string;
    siteId?: string;
  }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    // 사업장 격리: siteId가 있으면 해당 사업장 작업자만 조회
    if (params.siteId) where.siteId = params.siteId;
    // 관리 역할(MASTER/ADMIN)은 작업자 목록에서 제외
    where.role = { notIn: [...MANAGEMENT_ROLES] };

    const [data, total] = await Promise.all([
      this.prisma.worker.findMany({
        where,
        select: {
          id: true,
          name: true,
          employeeCode: true,
          email: true,
          role: true,
          status: true,
          mobileVisible: true,
          siteId: true,
          site: { select: { name: true, code: true } },
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.worker.count({ where }),
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
   * 모바일용: 활성 작업자 목록 (최소 필드만)
   */
  async findActiveForMobile(siteId?: string) {
    const where: Record<string, unknown> = {
      status: 'ACTIVE',
      role: { notIn: ['MASTER', 'ADMIN'] },
      mobileVisible: true,
    };
    if (siteId) where.siteId = siteId;

    return this.prisma.worker.findMany({
      where,
      select: {
        id: true,
        name: true,
        employeeCode: true,
        role: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * 작업자 상세 조회
   */
  async findOne(id: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        role: true,
        status: true,
        siteId: true,
        site: { select: { name: true, code: true } },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!worker) {
      throw new NotFoundException('작업자를 찾을 수 없습니다');
    }

    return worker;
  }

  /**
   * 작업자 생성 (관리자 전용)
   * @param dto 작업자 정보
   * @param callerSiteId 호출자의 사업장 ID (ADMIN이면 자동 배정)
   */
  async create(dto: CreateWorkerDto, callerSiteId?: string) {
    // 사번 중복 확인
    const existing = await this.prisma.worker.findUnique({
      where: { employeeCode: dto.employeeCode },
    });

    if (existing) {
      throw new ConflictException(`사번 '${dto.employeeCode}'은(는) 이미 사용 중입니다`);
    }

    // PIN 해시
    const hashedPin = await bcrypt.hash(dto.pin, 10);

    // siteId 결정: DTO에 있으면 사용, 없으면 호출자의 siteId 자동 배정
    const siteId = dto.siteId || callerSiteId || null;

    const worker = await this.prisma.worker.create({
      data: {
        name: dto.name,
        employeeCode: dto.employeeCode,
        pin: hashedPin,
        role: dto.role,
        status: dto.status,
        ...(siteId && { siteId }),
      },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        role: true,
        status: true,
        siteId: true,
        site: { select: { name: true, code: true } },
        createdAt: true,
      },
    });

    this.logger.log(
      `Worker created: ${worker.employeeCode} (${worker.name}) → site: ${worker.site?.name || 'none'}`,
    );
    return worker;
  }

  /**
   * 작업자 정보 수정 (관리자 전용)
   */
  async update(id: string, dto: UpdateWorkerDto) {
    const existing = await this.prisma.worker.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('작업자를 찾을 수 없습니다');
    }

    // 사번 변경 시 중복 확인
    if (dto.employeeCode && dto.employeeCode !== existing.employeeCode) {
      const duplicate = await this.prisma.worker.findUnique({
        where: { employeeCode: dto.employeeCode },
      });
      if (duplicate) {
        throw new ConflictException(`사번 '${dto.employeeCode}'은(는) 이미 사용 중입니다`);
      }
    }

    // PIN 변경 시 해시
    const updateData: Record<string, unknown> = { ...dto };
    if (dto.pin) {
      updateData.pin = await bcrypt.hash(dto.pin, 10);
    }

    const worker = await this.prisma.worker.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        employeeCode: true,
        role: true,
        status: true,
        siteId: true,
        site: { select: { name: true, code: true } },
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Worker updated: ${worker.employeeCode}`);
    return worker;
  }

  /**
   * 작업자 영구 삭제
   * 작업 기록이 있으면 삭제 불가 (비활성화 권장)
   */
  async delete(id: string): Promise<void> {
    const existing = await this.prisma.worker.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('작업자를 찾을 수 없습니다');

    const workItemCount = await this.prisma.workItem.count({
      where: {
        OR: [
          { startedByWorkerId: id },
          { endedByWorkerId: id },
          { assignments: { some: { workerId: id } } },
        ],
      },
    });

    if (workItemCount > 0) {
      throw new ConflictException(
        `작업 기록이 ${workItemCount}건 있어 삭제할 수 없습니다. 비활성화를 사용하세요.`,
      );
    }

    // 연관 레코드 먼저 삭제 (외래키 제약)
    await this.prisma.$transaction([
      this.prisma.userConsent.deleteMany({ where: { workerId: id } }),
      this.prisma.loginHistory.deleteMany({ where: { workerId: id } }),
      this.prisma.adminActivityLog.deleteMany({ where: { workerId: id } }),
      this.prisma.worker.delete({ where: { id } }),
    ]);
    this.logger.log(`Worker deleted: ${existing.employeeCode}`);
  }
}
