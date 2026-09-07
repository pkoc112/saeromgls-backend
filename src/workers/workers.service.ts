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
import { UsageLimitService } from '../subscriptions/usage-limit.service';

/** 관리 역할 — 작업자 목록에서 제외 */
const MANAGEMENT_ROLES = ['MASTER', 'ADMIN'] as const;

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usageLimit: UsageLimitService,
  ) {}

  /**
   * 작업자 jobTrack 구 5트랙 → 신 4트랙 일괄 마이그레이션
   * - OUTBOUND_RANKED   → OUTBOUND
   * - INBOUND_SUPPORT   → INBOUND_DOCK
   * - DOCK_WRAP_GOAL    → INBOUND_DOCK (상하차 흡수)
   * - INSPECTION_GOAL   → INSPECTION
   * - MANAGER_OPS       → MANAGER
   */
  async migrateJobTracksV3(siteId?: string) {
    const mapping: Record<string, string> = {
      OUTBOUND_RANKED: 'OUTBOUND',
      INBOUND_SUPPORT: 'INBOUND_DOCK',
      DOCK_WRAP_GOAL:  'INBOUND_DOCK',
      INSPECTION_GOAL: 'INSPECTION',
      MANAGER_OPS:     'MANAGER',
    };

    const siteFilter = siteId
      ? { OR: [{ siteId }, { siteId: null }] }
      : {};

    const results: Array<{ from: string; to: string; count: number }> = [];
    let totalUpdated = 0;

    for (const [oldTrack, newTrack] of Object.entries(mapping)) {
      const res = await this.prisma.worker.updateMany({
        where: { ...siteFilter, jobTrack: oldTrack },
        data: { jobTrack: newTrack },
      });
      if (res.count > 0) {
        results.push({ from: oldTrack, to: newTrack, count: res.count });
        totalUpdated += res.count;
      }
    }

    this.logger.log(`jobTrack migration v3: ${totalUpdated} workers updated`);
    return {
      message: `작업자 ${totalUpdated}명의 직무트랙이 신 4트랙으로 마이그레이션되었습니다`,
      totalUpdated,
      details: results,
    };
  }

  /**
   * 관리자용: 작업자 목록 조회 (페이지네이션, 상태/사업장 필터)
   */
  async findAll(params: {
    page?: number;
    limit?: number;
    status?: string;
    siteId?: string;
    role?: string; // 특정 역할만 조회 (관리자 등). 미지정 시 관리역할 제외(기본)
    callerRole?: string; // 호출자 역할 — 관리역할 조회 권한 게이트
  }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    // 사업장 격리: siteId가 있으면 해당 사업장 작업자만 조회
    if (params.siteId) where.siteId = params.siteId;
    // 역할 필터:
    //  - 기본: 관리 역할(MASTER/ADMIN)은 작업자 목록에서 제외
    //  - role 지정 시: 해당 역할만 조회. 단 관리 역할 조회는 MASTER/ADMIN만, MASTER 조회는 MASTER만 허용
    const requestedRole = params.role?.trim().toUpperCase();
    const callerCanSeeMgmt =
      params.callerRole === 'MASTER' || params.callerRole === 'ADMIN';
    if (requestedRole) {
      const isMgmt = (MANAGEMENT_ROLES as readonly string[]).includes(requestedRole);
      const masterDenied = requestedRole === 'MASTER' && params.callerRole !== 'MASTER';
      if ((isMgmt && !callerCanSeeMgmt) || masterDenied) {
        where.role = { notIn: [...MANAGEMENT_ROLES] };
      } else {
        where.role = requestedRole;
      }
    } else {
      where.role = { notIn: [...MANAGEMENT_ROLES] };
    }

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
          jobTrack: true,
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

  /** 센터별 사번 접두어 (TenantSettings JSON의 workerCodePrefix). 없으면 null. */
  private async getWorkerCodePrefix(siteId: string): Promise<string | null> {
    try {
      const ts = await this.prisma.tenantSettings.findFirst({
        where: { siteId },
        select: { settings: true },
      });
      if (!ts?.settings) return null;
      const parsed = JSON.parse(ts.settings);
      const prefix =
        typeof parsed?.workerCodePrefix === 'string' ? parsed.workerCodePrefix.trim() : '';
      return prefix || null;
    } catch {
      return null;
    }
  }

  /**
   * 작업자 생성 (관리자 전용)
   * @param dto 작업자 정보
   * @param callerSiteId 호출자의 사업장 ID (ADMIN이면 자동 배정)
   */
  async create(dto: CreateWorkerDto, callerSiteId?: string) {
    // siteId 결정: DTO에 있으면 사용, 없으면 호출자의 siteId 자동 배정
    const siteId = dto.siteId || callerSiteId || null;

    // 사번 접두어 자동 적용 — 센터별 TenantSettings.workerCodePrefix (예: "DH" → "DH-001").
    // 전역 unique 제약 하에서도 센터 간 사번 충돌을 방지(마이그레이션 불필요). 이미 접두어가 있으면 중복 적용 안 함.
    let employeeCode = dto.employeeCode.trim();
    if (siteId) {
      const prefix = await this.getWorkerCodePrefix(siteId);
      if (prefix && !employeeCode.toUpperCase().startsWith(prefix.toUpperCase())) {
        employeeCode = `${prefix}-${employeeCode}`;
      }
    }

    // 사번 중복 확인 (최종 코드 기준)
    const existing = await this.prisma.worker.findUnique({
      where: { employeeCode },
    });
    if (existing) {
      throw new ConflictException(`사번 '${employeeCode}'은(는) 이미 사용 중입니다`);
    }

    // PIN 해시
    const hashedPin = await bcrypt.hash(dto.pin, 10);

    // 플랜 작업자 상한 강제 (siteId가 있고 ACTIVE 작업자일 때).
    // 구독 없으면 canAddWorker=true라 자체운영/무료 사업장은 영향 없음.
    if (siteId && dto.status !== 'INACTIVE') {
      await this.usageLimit.enforceWorkerLimit(siteId);
    }

    const worker = await this.prisma.worker.create({
      data: {
        name: dto.name,
        employeeCode,
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

    // 사번 변경 시: create와 동일하게 센터 prefix 적용 후 중복 확인
    // (prefix 미적용 시 raw 사번이 센터 간 전역 충돌하던 갭 보완)
    if (dto.employeeCode && dto.employeeCode !== existing.employeeCode) {
      let newCode = dto.employeeCode.trim();
      if (existing.siteId) {
        const prefix = await this.getWorkerCodePrefix(existing.siteId);
        if (prefix && !newCode.toUpperCase().startsWith(prefix.toUpperCase())) {
          newCode = `${prefix}-${newCode}`;
        }
      }
      const duplicate = await this.prisma.worker.findUnique({
        where: { employeeCode: newCode },
      });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`사번 '${newCode}'은(는) 이미 사용 중입니다`);
      }
      dto.employeeCode = newCode;
    }

    const updateData: Record<string, unknown> = { ...dto };

    // 이메일 변경 시 유일성 확인 (이메일 = 로그인 ID, @unique). 빈 문자열은 null(해제) 처리.
    if (dto.email !== undefined) {
      const normalizedEmail = dto.email.trim() || null;
      if (normalizedEmail && normalizedEmail !== existing.email) {
        const dupEmail = await this.prisma.worker.findUnique({
          where: { email: normalizedEmail },
        });
        if (dupEmail && dupEmail.id !== id) {
          throw new ConflictException(`이메일 '${normalizedEmail}'은(는) 이미 사용 중입니다`);
        }
      }
      updateData.email = normalizedEmail;
    }

    // PIN 변경 시 해시
    if (dto.pin) {
      updateData.pin = await bcrypt.hash(dto.pin, 10);
    }

    // 비밀번호 재설정 시 해시 (이메일 로그인용). raw password는 저장하지 않음.
    if (dto.password) {
      updateData.passwordHash = await bcrypt.hash(dto.password, 10);
      delete updateData.password;
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

    // 핵심 차단: 작업 기록이 있으면 삭제 불가 (work_items는 항상 존재하는 코어 테이블).
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

    // 연관 레코드 정리(best-effort). 일부 모듈 테이블이 prod에 없을 수 있어(마이그레이션 보류로 인한 드리프트)
    // 개별 try/catch로 감싼다. 없는 테이블/제약은 건너뛰고, 핵심 worker.delete만 확실히 처리.
    const cleanups: Array<() => Promise<unknown>> = [
      () => this.prisma.userConsent.deleteMany({ where: { workerId: id } }),
      () => this.prisma.loginHistory.deleteMany({ where: { workerId: id } }),
      () => this.prisma.refreshToken.deleteMany({ where: { workerId: id } }),
      () => this.prisma.adminActivityLog.deleteMany({ where: { actorWorkerId: id } }),
      () => this.prisma.auditLog.deleteMany({ where: { actorWorkerId: id } }),
      () => this.prisma.scoreEntry.deleteMany({ where: { workerId: id } }),
      () => this.prisma.objectionCase.deleteMany({ where: { workerId: id } }),
      () => this.prisma.inboundParticipant.deleteMany({ where: { workerId: id } }),
      () => this.prisma.dockParticipant.deleteMany({ where: { workerId: id } }),
      () => this.prisma.restoreRequest.deleteMany({ where: { requestedByWorkerId: id } }),
      () =>
        this.prisma.inboundSession.updateMany({
          where: { approvedByWorkerId: id },
          data: { approvedByWorkerId: null },
        }),
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (e: any) {
        // 드리프트(P2021/P2022)·일시오류는 무시하고 계속 — 남은 FK는 worker.delete가 잡음
        this.logger.warn(
          `Worker delete cleanup skipped (${existing.employeeCode}): ${e?.code ?? e?.message ?? 'unknown'}`,
        );
      }
    }

    // 작업자 삭제 — 남은 FK(정산/검수/상하차 등)가 있으면 친절히 차단.
    try {
      await this.prisma.worker.delete({ where: { id } });
    } catch (e: any) {
      const code = e?.code || 'UNKNOWN';
      this.logger.error(
        `Worker delete failed (${existing.employeeCode}): ${code} ${e?.message ?? ''}`,
      );
      if (code === 'P2003') {
        throw new ConflictException(
          '이 작업자와 연결된 기록(정산/검수/상하차 등)이 있어 영구 삭제할 수 없습니다. 비활성화를 사용해주세요.',
        );
      }
      if (code === 'P2025') {
        throw new NotFoundException('이미 삭제된 작업자입니다');
      }
      throw new ConflictException(
        `영구 삭제에 실패했습니다 (오류 ${code}). 비활성화를 사용해주세요.`,
      );
    }
    this.logger.log(`Worker deleted: ${existing.employeeCode}`);
  }
}
