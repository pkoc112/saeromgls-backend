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

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관리자용: 작업자 목록 조회 (페이지네이션, 상태 필터)
   */
  async findAll(params: { page?: number; limit?: number; status?: string }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where = params.status ? { status: params.status } : {};

    const [data, total] = await Promise.all([
      this.prisma.worker.findMany({
        where,
        select: {
          id: true,
          name: true,
          employeeCode: true,
          role: true,
          status: true,
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
   */
  async create(dto: CreateWorkerDto) {
    // 사번 중복 확인
    const existing = await this.prisma.worker.findUnique({
      where: { employeeCode: dto.employeeCode },
    });

    if (existing) {
      throw new ConflictException(`사번 '${dto.employeeCode}'은(는) 이미 사용 중입니다`);
    }

    // PIN 해시
    const hashedPin = await bcrypt.hash(dto.pin, 10);

    const worker = await this.prisma.worker.create({
      data: {
        name: dto.name,
        employeeCode: dto.employeeCode,
        pin: hashedPin,
        role: dto.role,
        status: dto.status,
      },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    this.logger.log(`Worker created: ${worker.employeeCode} (${worker.name})`);
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
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Worker updated: ${worker.employeeCode}`);
    return worker;
  }
}
