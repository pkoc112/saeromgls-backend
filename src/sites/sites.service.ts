import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSystemActorId, systemMetadata } from '../common/utils/system-actor';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { CloneSettingsDto } from './dto/clone-settings.dto';

/**
 * 태블릿(키오스크) 자동발급 계정의 사번 접미어.
 * 사번은 `<사업장코드>-KIOSK` (사업장 코드가 전역 unique이므로 사번도 전역 unique 보장).
 */
const KIOSK_CODE_SUFFIX = '-KIOSK';

/** 사업장 생성 시 1회만 평문으로 반환되는 태블릿 로그인 정보 */
export interface KioskCredentials {
  employeeCode: string;
  pin: string;
}

/**
 * #27 센터 설정 복제 시 TenantSettings JSON 에서 대상으로 병합하는 키 allowlist.
 * ★ 제외(센터 고유 값): latitude / longitude / alertEmail / workerCodePrefix / notifications / noticeMessage
 *   — 좌표·알림·사번접두어를 복제하면 폭염알림 오발송, 사번 충돌, 공지 오노출이 생기므로 절대 포함 금지.
 */
const CLONE_SETTINGS_ALLOWLIST = [
  'workStartHour',
  'workEndHour',
  'kioskMode',
  'autoScreensaverSeconds',
  'classificationModes',
] as const;

/** 휴게시간 설정 사이트당 최대 개수 (break-configs.service validateMaxCount 와 동일) */
const BREAK_CONFIG_MAX_PER_SITE = 10;

/** POST /admin/sites/:id/clone-settings 응답 */
export interface CloneSettingsResult {
  classifications: { created: number; skipped: number };
  breakConfigs: { created: number; skipped: number };
  /** 실제 병합된 TenantSettings 키 (소스에 값이 있던 allowlist 키만) */
  settingsMerged: string[];
}

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 사업장 목록의 '담당자' 노출용 workers include.
   * ADMIN/SUPERVISOR + ACTIVE 만, 태블릿 키오스크 계정(-KIOSK)은 사람이 아니므로 제외.
   * 호출 측(MASTER 전체 / ADMIN 자기 사업장)은 이미 사업장 범위가 제한되어 있어 추가 격리 불필요.
   */
  private managersInclude() {
    return {
      where: {
        role: { in: ['ADMIN', 'SUPERVISOR'] },
        status: 'ACTIVE',
        NOT: { employeeCode: { contains: KIOSK_CODE_SUFFIX } },
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ role: 'asc' as const }, { name: 'asc' as const }],
    };
  }

  /**
   * 관리 활동 감사 로그 (DB) — 테넌트 개통/삭제 등 추적 (개통 분석 P2).
   * 감사 기록 실패가 본 작업을 막지 않도록 try/catch 로 흡수.
   * actorWorkerId 가 없으면(시스템 행위) MASTER 계정을 행위자로 쓰고 metadata.system=true 로 구분
   * — actor_worker_id 는 workers FK 라 'SYSTEM' 문자열은 FK 위반으로 기록 자체가 안 됐음.
   */
  private async logActivity(
    actorWorkerId: string | null | undefined,
    actionType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const isSystem = !actorWorkerId;
      const actor = actorWorkerId || (await resolveSystemActorId(this.prisma));
      if (!actor) {
        this.logger.warn(`AdminActivityLog 기록 생략(${actionType}): 시스템 행위자(MASTER) 없음`);
        return;
      }
      await this.prisma.adminActivityLog.create({
        data: {
          actorWorkerId: actor,
          actionType,
          targetType: 'SITE',
          targetId,
          metadata: isSystem ? systemMetadata(metadata) : JSON.stringify(metadata),
        },
      });
    } catch (err) {
      this.logger.warn(`AdminActivityLog 기록 실패(${actionType}): ${err}`);
    }
  }

  /**
   * 전체 사업장 목록 조회 (이름순 정렬) — MASTER 전용.
   * 응답 `managers`: 담당 관리자(ADMIN/SUPERVISOR, ACTIVE) [{ id, name, email, role }] — MASTER 조회이므로 마스킹 없음.
   */
  async findAll() {
    const sites = await this.prisma.site.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { workers: true, childSites: true } },
        parentSite: { select: { id: true, name: true, code: true } },
        workers: this.managersInclude(),
      },
    });

    return sites.map((site) => ({
      ...site,
      workerCount: site._count.workers,
      childCount: site._count.childSites,
      managers: site.workers,
      workers: undefined,
      _count: undefined,
    }));
  }

  /**
   * 소속 사업장만 조회 (ADMIN용). `managers`는 자기 사업장 범위 안의 관리자만 포함(교차 테넌트 노출 없음).
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
        workers: this.managersInclude(),
      },
    });
    return sites.map((site) => ({
      ...site,
      workerCount: site._count.workers,
      childCount: site._count.childSites,
      managers: site.workers,
      workers: undefined,
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
   *
   * 최상위 사이트(parentSiteId 없음) 생성 시 응답에 `kiosk: { employeeCode, pin }`(평문 PIN, 이 응답 1회만)이
   * 포함된다 — 태블릿 로그인용 SUPERVISOR 계정이 자동 발급되기 때문. 하위 사업장은 `kiosk` 없음.
   */
  async create(dto: CreateSiteDto, actorId?: string) {
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

    // ★ 태블릿(키오스크) 계정 자격증명은 트랜잭션 밖에서 미리 준비 (bcrypt 비용을 tx 타임아웃에서 분리).
    //   PIN: 암호학적 난수 6자리, 해시는 workers.service 와 동일 (bcrypt salt 10).
    let kioskPlain: KioskCredentials | null = null;
    let kioskPinHash: string | null = null;
    if (!dto.parentSiteId) {
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      kioskPinHash = await bcrypt.hash(pin, 10);
      kioskPlain = { employeeCode: `${dto.code}${KIOSK_CODE_SUFFIX}`, pin };
    }

    const { created: site, kiosk } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.site.create({
        data: {
          name: dto.name,
          code: dto.code,
          parentSiteId: dto.parentSiteId ?? null,
        },
      });

      // ★ 최상위 사이트(고객사 테넌트 루트)만 부트스트랩.
      //   하위 사업장(parentSiteId 있음)은 부모 테넌트의 구독/설정을 공유하므로 제외.
      if (!dto.parentSiteId) {
        // 1) 기본 휴게시간 (점심 12:00~13:00) — 신규 센터 빈 휴게설정 방지
        await tx.breakConfig.create({
          data: {
            label: '점심',
            startHour: 12,
            startMin: 0,
            endHour: 13,
            endMin: 0,
            siteId: created.id,
            sortOrder: 0,
          },
        });

        // 2) 온보딩 진행 추적(9단계)
        await tx.onboardingRun.create({
          data: { siteId: created.id, step: 1, totalSteps: 9, status: 'IN_PROGRESS' },
        });

        // 3) 테넌트 기본 설정(JSON) — 좌표/알림이메일은 추후 이 JSON으로 확장
        //    ★ workerCodePrefix를 사이트코드 기반으로 자동 시드 → 신규 센터 사번이
        //      'DH-001'처럼 전역 유일해져, 전역 @unique 하에서도 센터 간 '001' 충돌을
        //      구조적으로 차단(스키마/로그인 변경 불필요). 비알파넘 코드면 빈 값(운영자 수동 설정).
        const seededPrefix = dto.code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
        await tx.tenantSettings.create({
          data: {
            siteId: created.id,
            settings: JSON.stringify({
              timezone: 'Asia/Seoul',
              language: 'ko',
              workStartHour: 8,
              workEndHour: 18,
              kioskMode: true,
              autoScreensaverSeconds: 600,
              noticeMessage: '',
              ...(seededPrefix ? { workerCodePrefix: seededPrefix } : {}),
            }),
          },
        });

        // 4) 무료 체험 자동 부여 (BASIC 14일) — 신규 센터가 바로 무료로 사용 가능.
        //    BASIC 플랜이 없으면 체험은 건너뛰고 사이트 생성은 정상 진행.
        const basic = await tx.plan.findUnique({ where: { code: 'BASIC' } });
        if (basic) {
          const now = new Date();
          const trialEnd = new Date(now);
          trialEnd.setDate(trialEnd.getDate() + 14);
          await tx.subscription.create({
            data: {
              siteId: created.id,
              planId: basic.id,
              status: 'TRIAL',
              billingCycle: 'MONTHLY',
              trialEndsAt: trialEnd,
              currentPeriodStart: now,
              currentPeriodEnd: trialEnd,
            },
          });
          this.logger.log(`Trial(BASIC,14d) granted to new site ${created.code}`);
        } else {
          this.logger.warn(`BASIC plan not found — trial skipped for site ${created.code}`);
        }

        // 5) 태블릿(키오스크) 로그인 계정 자동 발급 — 신규 센터가 관리자 초대 없이도 바로 태블릿 로그인 가능.
        //    - role SUPERVISOR: PIN 로그인 목록(/mobile/workers → filterLoginWorkers)은 WORKER만 제외하므로 로그인 가능
        //    - mobileVisible true 필수: /mobile/workers 가 mobileVisible=true 만 반환하므로 false 면 PIN 로그인 목록에
        //      아예 안 떠서 계정이 무용지물이 됨. (작업자 선택 카드에도 노출되는 부작용은 이름 '태블릿-<코드>'로 식별)
        //    - 사번 `<코드>-KIOSK`: 사업장 코드 전역 unique → 사번 전역 unique. 잔존 사번과 충돌 시 숫자 접미어 fallback.
        if (kioskPlain && kioskPinHash) {
          let employeeCode = kioskPlain.employeeCode;
          const taken = await tx.worker.findUnique({
            where: { employeeCode },
            select: { id: true },
          });
          if (taken) employeeCode = `${employeeCode}${randomInt(10, 100)}`;

          await tx.worker.create({
            data: {
              name: `태블릿-${created.code}`,
              employeeCode,
              pin: kioskPinHash,
              role: 'SUPERVISOR',
              status: 'ACTIVE',
              mobileVisible: true,
              siteId: created.id,
            },
          });
          kioskPlain = { ...kioskPlain, employeeCode };
          this.logger.log(`Kiosk account issued for site ${created.code}: ${employeeCode}`);
        }
      }

      return { created, kiosk: kioskPlain };
    });

    this.logger.log(`Site created: ${site.name} (${site.code})`);
    await this.logActivity(actorId, 'SITE_CREATE', site.id, {
      name: site.name,
      code: site.code,
      parentSiteId: dto.parentSiteId ?? null,
      bootstrappedTrial: !dto.parentSiteId,
      // PIN 은 절대 기록하지 않음 — 사번만
      kioskEmployeeCode: kiosk?.employeeCode ?? null,
    });
    // 기존 반환 shape 유지(하위 사업장은 site 그대로). 최상위만 kiosk 평문을 1회 첨부.
    return kiosk ? { ...site, kiosk } : site;
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
  async remove(id: string, actorId?: string) {
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
    await this.logActivity(actorId, 'SITE_DELETE', id, {
      name: existing.name,
      code: existing.code,
    });
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

    // ★ 멀티센터 안전장치 (개통 분석 P0-4):
    //   활성 최상위 사이트가 2개 이상이면 'siteId=null 자원 무차별 흡수'를 금지한다.
    //   (2번째 센터 개통 중 이 버튼을 누르면 대구의 미배정 작업자/전역 휴게설정이
    //    신규 센터로 끌려가는 교차 테넌트 오배정 사고를 방지)
    const topLevelCount = await this.prisma.site.count({
      where: { parentSiteId: null, isActive: true },
    });
    const multiTenant = topLevelCount > 1;

    let result: { count: number };
    let breakResult: { count: number } = { count: 0 };

    if (multiTenant) {
      // 멀티센터: DEFAULT 사업장 소속 작업자만 이관, null 자원은 절대 흡수하지 않음.
      if (!defaultSite) {
        throw new BadRequestException(
          '멀티센터 환경에서는 미배정(null) 자원 일괄 이관이 비활성화됩니다. 작업자 관리에서 개별 이관하세요.',
        );
      }
      result = await this.prisma.worker.updateMany({
        where: { siteId: defaultSite.id },
        data: { siteId: targetSiteId },
      });
      // 전역(null) 휴게설정은 이관하지 않음 (다른 테넌트 공유 가능성)
    } else {
      // 단일 테넌트(레거시): 기존 동작 유지 — null/DEFAULT 작업자 + null 휴게설정 이관
      result = await this.prisma.worker.updateMany({
        where: {
          OR: [
            { siteId: null },
            ...(defaultSite ? [{ siteId: defaultSite.id }] : []),
          ],
        },
        data: { siteId: targetSiteId },
      });
      breakResult = await this.prisma.breakConfig.updateMany({
        where: { siteId: null },
        data: { siteId: targetSiteId },
      });
    }

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
   * #27 센터 설정 복제 — 소스 사업장의 분류/휴게시간/테넌트 설정을 대상 사업장으로 복사 (MASTER 전용).
   *
   * 트랜잭션 1개로 처리:
   *  (a) Classification: 소스 활성 분류(소스가 대구처럼 siteId=NULL 전역분류를 쓰는 경우 OR-null 포함)를
   *      대상 siteId 로 code/displayName/sortOrder 그대로 생성. (대상 siteId, code) 가 이미 있으면 skip
   *      (복합 unique). includeChildren=false 면 최상위(code 에 언더스코어 없음)만.
   *  (b) BreakConfig: 소스 활성 휴게시간 복사. 대상에 같은 label+시간이 있거나 대상 활성 휴게시간과
   *      시간대가 겹치면 skip (break-configs.service 의 중복/겹침 불변식 유지). 사이트당 최대 10개.
   *  (c) TenantSettings: 대상 JSON 에 allowlist 키만 병합 (CLONE_SETTINGS_ALLOWLIST 참고).
   *      classificationModes 는 카테고리 단위 얕은 병합(대상에만 있는 카테고리 모드는 보존).
   *
   * 호출자는 컨트롤러에서 @Roles('MASTER') 로 제한되지만, 서비스에서도 방어적으로 한 번 더 검사한다.
   */
  async cloneSettings(
    targetSiteId: string,
    dto: CloneSettingsDto,
    actor?: { sub?: string; role?: string },
  ): Promise<CloneSettingsResult> {
    if (actor && actor.role !== 'MASTER') {
      throw new ForbiddenException('센터 설정 복제는 MASTER만 실행할 수 있습니다');
    }

    const sourceSiteId = dto.sourceSiteId;
    if (sourceSiteId === targetSiteId) {
      throw new BadRequestException('소스 사업장과 대상 사업장이 같습니다. 다른 사업장을 선택하세요.');
    }

    const [source, target] = await Promise.all([
      this.prisma.site.findUnique({ where: { id: sourceSiteId }, select: { id: true, name: true, code: true } }),
      this.prisma.site.findUnique({ where: { id: targetSiteId }, select: { id: true, name: true, code: true } }),
    ]);
    if (!source) throw new NotFoundException('소스 사업장을 찾을 수 없습니다');
    if (!target) throw new NotFoundException('대상 사업장을 찾을 수 없습니다');

    const includeChildren = dto.includeChildren === true;

    const result = await this.prisma.$transaction(async (tx) => {
      // ─────────── (a) Classification ───────────
      // 소스가 전역(siteId=null) 분류를 쓰는 레거시 센터일 수 있으므로 classifications.service.findAll 과 동일한 OR-null 패턴.
      const sourceClassifications = await tx.classification.findMany({
        where: {
          isActive: true,
          OR: [{ siteId: sourceSiteId }, { siteId: null }],
        },
        select: { code: true, displayName: true, sortOrder: true, siteId: true },
        orderBy: { sortOrder: 'asc' },
      });

      // 같은 code 가 소스 전용 + 전역 양쪽에 있으면 소스 전용(관리자가 손본 값)을 우선.
      const byCode = new Map<string, { code: string; displayName: string; sortOrder: number }>();
      for (const c of sourceClassifications) {
        if (!includeChildren && c.code.includes('_')) continue; // 하위 납품처 제외
        const prev = byCode.get(c.code);
        if (!prev || c.siteId === sourceSiteId) {
          byCode.set(c.code, { code: c.code, displayName: c.displayName, sortOrder: c.sortOrder });
        }
      }

      const existingTarget = await tx.classification.findMany({
        where: { siteId: targetSiteId },
        select: { code: true },
      });
      const existingCodes = new Set(existingTarget.map((c) => c.code));

      const toCreate = [...byCode.values()].filter((c) => !existingCodes.has(c.code));
      let classificationsCreated = 0;
      if (toCreate.length > 0) {
        // (siteId, code) 복합 unique — 동시 생성 경쟁이 있어도 skipDuplicates 로 안전.
        const created = await tx.classification.createMany({
          data: toCreate.map((c) => ({
            siteId: targetSiteId,
            code: c.code,
            displayName: c.displayName,
            sortOrder: c.sortOrder,
            isActive: true,
          })),
          skipDuplicates: true,
        });
        classificationsCreated = created.count;
      }
      const classificationsSkipped = byCode.size - classificationsCreated;

      // ─────────── (b) BreakConfig ───────────
      const sourceBreaks = await tx.breakConfig.findMany({
        where: { siteId: sourceSiteId, isActive: true },
        select: { label: true, startHour: true, startMin: true, endHour: true, endMin: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      });
      const targetBreaks = await tx.breakConfig.findMany({
        where: { siteId: targetSiteId },
        select: { label: true, startHour: true, startMin: true, endHour: true, endMin: true, isActive: true },
      });

      const sameBreak = (
        a: { label: string; startHour: number; startMin: number; endHour: number; endMin: number },
        b: { label: string; startHour: number; startMin: number; endHour: number; endMin: number },
      ) =>
        a.label === b.label &&
        a.startHour === b.startHour &&
        a.startMin === b.startMin &&
        a.endHour === b.endHour &&
        a.endMin === b.endMin;
      const overlaps = (
        a: { startHour: number; startMin: number; endHour: number; endMin: number },
        b: { startHour: number; startMin: number; endHour: number; endMin: number },
      ) => {
        const aS = a.startHour * 60 + a.startMin;
        const aE = a.endHour * 60 + a.endMin;
        const bS = b.startHour * 60 + b.startMin;
        const bE = b.endHour * 60 + b.endMin;
        return aS < bE && aE > bS;
      };

      // 대상의 현재 활성 휴게시간(+이번에 추가되는 것)과 비교 — 사이트당 최대 10개 유지.
      const activeTargetBreaks = targetBreaks.filter((b) => b.isActive);
      let breaksCreated = 0;
      let breaksSkipped = 0;
      for (const sb of sourceBreaks) {
        const duplicate = targetBreaks.some((tb) => sameBreak(sb, tb));
        const overlapping = activeTargetBreaks.some((tb) => overlaps(sb, tb));
        if (duplicate || overlapping || activeTargetBreaks.length >= BREAK_CONFIG_MAX_PER_SITE) {
          breaksSkipped++;
          continue;
        }
        await tx.breakConfig.create({
          data: {
            siteId: targetSiteId,
            label: sb.label,
            startHour: sb.startHour,
            startMin: sb.startMin,
            endHour: sb.endHour,
            endMin: sb.endMin,
            sortOrder: sb.sortOrder,
            isActive: true,
          },
        });
        activeTargetBreaks.push({ ...sb, isActive: true });
        breaksCreated++;
      }

      // ─────────── (c) TenantSettings (allowlist 병합) ───────────
      const [sourceTs, targetTs] = await Promise.all([
        tx.tenantSettings.findUnique({ where: { siteId: sourceSiteId }, select: { settings: true } }),
        tx.tenantSettings.findUnique({ where: { siteId: targetSiteId }, select: { settings: true } }),
      ]);
      const sourceSettings = this.safeParseSettings(sourceTs?.settings);
      const targetSettings = this.safeParseSettings(targetTs?.settings);

      const settingsMerged: string[] = [];
      const merged: Record<string, unknown> = { ...targetSettings };
      for (const key of CLONE_SETTINGS_ALLOWLIST) {
        const value = sourceSettings[key];
        if (value === undefined || value === null) continue;
        if (key === 'classificationModes') {
          if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length === 0) continue;
          const sourceModes = value as Record<string, string>;
          const targetModes =
            targetSettings.classificationModes && typeof targetSettings.classificationModes === 'object'
              ? (targetSettings.classificationModes as Record<string, string>)
              : {};
          // includeChildren=false 여도 모드는 카테고리(최상위 코드) 단위라 그대로 병합 가능.
          merged.classificationModes = { ...targetModes, ...sourceModes };
        } else {
          merged[key] = value;
        }
        settingsMerged.push(key);
      }

      if (settingsMerged.length > 0) {
        await tx.tenantSettings.upsert({
          where: { siteId: targetSiteId },
          update: { settings: JSON.stringify(merged) },
          create: {
            siteId: targetSiteId,
            // 대상에 설정 행이 없던 경우(하위 사업장 등) customer-ops 와 같은 기본값 위에 병합.
            settings: JSON.stringify({
              timezone: 'Asia/Seoul',
              language: 'ko',
              workStartHour: 8,
              workEndHour: 18,
              kioskMode: true,
              autoScreensaverSeconds: 600,
              noticeMessage: '',
              ...merged,
            }),
          },
        });
      }

      return {
        classifications: { created: classificationsCreated, skipped: classificationsSkipped },
        breakConfigs: { created: breaksCreated, skipped: breaksSkipped },
        settingsMerged,
      } satisfies CloneSettingsResult;
    });

    this.logger.log(
      `Site settings cloned ${source.code} → ${target.code}: ` +
        `classifications +${result.classifications.created}/skip ${result.classifications.skipped}, ` +
        `breaks +${result.breakConfigs.created}/skip ${result.breakConfigs.skipped}, ` +
        `settings [${result.settingsMerged.join(',')}] (includeChildren=${includeChildren})`,
    );
    await this.logActivity(actor?.sub, 'SITE_CLONE_SETTINGS', target.id, {
      sourceSiteId: source.id,
      sourceCode: source.code,
      targetCode: target.code,
      includeChildren,
      ...result,
    });

    return result;
  }

  /** TenantSettings.settings(JSON 문자열) 안전 파싱 — 깨진 JSON/비객체는 {} */
  private safeParseSettings(raw?: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
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
