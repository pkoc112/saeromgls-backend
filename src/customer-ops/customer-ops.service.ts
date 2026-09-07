import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { kstDateRange, kstStartOfDay } from '../common/kst-date.util';
import {
  calcNetWorkMinutes,
  loadBreakConfigResolver,
} from '../common/utils/net-work-minutes';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSiteFromTemplateDto,
  CreateSupportCaseDto,
  GenerateUsageSnapshotDto,
  ResolveSupportCaseDto,
  UpdateOnboardingRunDto,
  UpsertTenantSettingsDto,
} from './dto/customer-ops.dto';

type SiteHealth = 'HEALTHY' | 'NEEDS_ATTENTION' | 'AT_RISK';

/** #31 아침 운영 다이제스트 — 센터별 이상 항목 */
type DigestSeverity = 'critical' | 'warning';
interface DigestIssue {
  type:
    | 'subscription'
    | 'trial'
    | 'coords'
    | 'tablet'
    | 'no_work'
    | 'stuck'
    | 'check_failed';
  severity: DigestSeverity;
  title: string;
  detail: string;
}
interface DigestSiteRow {
  siteId: string;
  siteName: string;
  siteCode: string;
  subscriptionStatus: string;
  workStartHour: number;
  issues: DigestIssue[];
}

/** 구독이 이 상태면 고객 운영 점검(태블릿/작업)은 의미 없음 — 구독 이상만 표기 */
const DIGEST_INACTIVE_SUBSCRIPTION = ['EXPIRED', 'SUSPENDED', 'CANCELLED'];

/** 태블릿 키오스크 계정 사번 접미어 (sites.service 와 동일) — 관리자/작업자 수 판정에서 제외 */
const KIOSK_CODE_SUFFIX = '-KIOSK';
/** #42 NULL 작업자(미배정) 비교 행 키 */
const UNASSIGNED_KEY = '__unassigned__';
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 60 * 60 * 1000;

/** #29 개통 준비도 — 항목별 판정 */
export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** 판정 근거 (예: "관리자/반장 2명", "마지막 보고 2026-09-07 10:00") */
  detail: string;
}
export interface SiteReadiness {
  siteId: string;
  name: string;
  code: string;
  required: ReadinessItem[];
  optional: ReadinessItem[];
  requiredOk: number;
  requiredTotal: number;
}

/** #42 센터 간 기간 비교 — 사이트별 집계 (OR-null 금지, NULL 작업자는 UNASSIGNED_KEY 단일 행) */
export interface PeriodAggregate {
  /** 기간 내 시작 작업 수 (VOID 제외) */
  count: number;
  volume: number;
  quantity: number;
  /** 건수 ÷ 활성 작업자 (활성 작업자 0이면 null) */
  perWorker: number | null;
  /** 종료 작업 평균 순작업시간(분, 중간마감·휴게 차감) — 종료 0건이면 null */
  avgNetMinutes: number | null;
  /** 기간 내 시작 후 8h+ 경과한 ACTIVE 작업 수 */
  stuckCount: number;
  /** 활성 작업자(ACTIVE, MASTER/ADMIN/키오스크 제외) */
  activeWorkerCount: number;
  endedCount: number;
}

/** #45 센터 연락처·메모 (TenantSettings JSON) */
export interface SiteContact {
  contactName: string | null;
  contactPhone: string | null;
  tabletDevice: string | null;
  tabletInstalledAt: string | null;
  siteMemo: string | null;
}

interface ResolvedPeriod {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
}

@Injectable()
export class CustomerOpsService {
  private readonly logger = new Logger(CustomerOpsService.name);
  private readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000;
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LONG_RUNNING_THRESHOLD_HOURS = 8;

  // ── #31 아침 운영 다이제스트 기준값 ──
  /** 장시간 미종료 판정 (ACTIVE 12h+) — 운영 콘솔(8h)보다 보수적 */
  private readonly DIGEST_STUCK_HOURS = 12;
  /** 체험 만료 경고 (D-3 이내) */
  private readonly DIGEST_TRIAL_WARN_DAYS = 3;
  /** 근무 시작 후 판정 유예 (태블릿 보고 / 작업 0건) */
  private readonly DIGEST_GRACE_HOURS = 2;
  /** TenantSettings.workStartHour 미설정 시 기본값 */
  private readonly DIGEST_DEFAULT_WORK_START_HOUR = 8;
  /** TenantSettings.workEndHour 미설정 시 기본값 (createSiteFromTemplate 기본값과 동일) */
  private readonly DEFAULT_WORK_END_HOUR = 18;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * MASTER 고객 운영 콘솔 개요
   * @param from/to #42 센터 간 비교 기간 (KST 'YYYY-MM-DD', 생략 시 이번 달) — 각 site.period 에 집계
   */
  async getCustomerOverview(siteId?: string, from?: string, to?: string) {
    const period = this.resolvePeriod(from, to);
    const { sites, unassigned } = await this.buildSiteOverview(siteId, period);

    const totalSites = sites.length;
    const activeSites = sites.filter((site) => site.isActive).length;
    const totalWorkers = sites.reduce((sum, site) => sum + site.workerCount, 0);
    const totalWorkItems = sites.reduce((sum, site) => sum + site.workItemCount, 0);
    const openCaseCount = sites.reduce((sum, site) => sum + site.openCaseCount, 0);
    const subscriptionRiskCount = sites.filter((site) =>
      ['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(
        site.subscriptionStatus,
      ),
    ).length;
    const onboardingIncompleteCount = sites.filter(
      (site) => site.onboarding.status !== 'COMPLETED',
    ).length;
    const attentionSiteCount = sites.filter(
      (site) => site.health !== 'HEALTHY',
    ).length;
    const lowActivityCount = sites.filter(
      (site) => site.daysSinceLastActivity !== null && site.daysSinceLastActivity >= 7,
    ).length;

    return {
      stats: {
        totalSites,
        activeSites,
        totalWorkers,
        totalWorkItems,
        openCaseCount,
        subscriptionRiskCount,
        onboardingIncompleteCount,
        attentionSiteCount,
        lowActivityCount,
      },
      period: { from: period.from, to: period.to },
      sites,
      // #42 NULL 작업자(미배정) 집계 — 비교표 단일 행. 없으면 null
      unassigned,
    };
  }

  // ══════════════════════════════════════════════
  // #29 개통 준비도 자동감지
  // ══════════════════════════════════════════════

  /**
   * 센터별 개통 준비도 — 실제 데이터 존재 여부로 판정 (수동 체크 없음).
   * 필수 4: 좌표 / 관리자 계정 / 분류 / 태블릿 첫 보고(HeatHourlyRecord).
   * 참고 5: 작업자 / 휴게시간 / 알림 이메일 / 사번 접두어 / 첫 작업 기록.
   * siteId 없으면(MASTER) 최상위 활성 센터 전체. 모든 조회는 siteId in [...] 배치.
   */
  async getReadiness(siteId?: string): Promise<{ sites: SiteReadiness[] }> {
    const sites = await this.prisma.site.findMany({
      where: siteId ? { id: siteId } : { parentSiteId: null, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { createdAt: 'asc' },
    });
    if (siteId && sites.length === 0) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }
    const settingsMap = await this.loadTenantSettingsMap(sites.map((site) => site.id));
    const readiness = await this.computeReadiness(sites, settingsMap);
    return {
      sites: sites
        .map((site) => readiness.get(site.id))
        .filter((row): row is SiteReadiness => !!row),
    };
  }

  /** 사이트별 TenantSettings JSON 을 1회 배치 조회 → Map<siteId, settings> */
  private async loadTenantSettingsMap(
    siteIds: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    if (siteIds.length === 0) return map;
    const rows = await this.prisma.tenantSettings.findMany({
      where: { siteId: { in: siteIds } },
      select: { siteId: true, settings: true },
    });
    for (const row of rows) {
      map.set(row.siteId, this.safeParseJson(row.settings));
    }
    return map;
  }

  /** heat-alerts getSiteConfig 와 동일 판정: 유한값 && 0 아님 */
  private coordsFromSettings(settings: Record<string, unknown>) {
    const lat = Number(settings.latitude);
    const lon = Number(settings.longitude);
    const ok = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;
    return { lat, lon, ok };
  }

  /**
   * 개통 준비도 계산 (getReadiness / buildSiteOverview 공용) — 5개 배치 쿼리.
   * 분류·휴게시간은 siteId 또는 NULL(전역) 을 포함, 태블릿 보고(HeatHourlyRecord)와
   * 작업자·관리자는 siteId 엄격 매칭 (NULL 행은 어느 센터에도 귀속하지 않음).
   */
  private async computeReadiness(
    sites: Array<{ id: string; name: string; code: string }>,
    settingsMap: Map<string, Record<string, unknown>>,
  ): Promise<Map<string, SiteReadiness>> {
    const result = new Map<string, SiteReadiness>();
    if (sites.length === 0) return result;
    const ids = sites.map((site) => site.id);

    const [workerGroups, classGroups, breakGroups, heatGroups, workedSites] =
      await Promise.all([
        this.prisma.worker.groupBy({
          by: ['siteId', 'role'],
          where: {
            siteId: { in: ids },
            status: 'ACTIVE',
            role: { in: ['ADMIN', 'SUPERVISOR', 'WORKER'] },
            NOT: { employeeCode: { contains: KIOSK_CODE_SUFFIX } },
          },
          _count: { _all: true },
        }),
        this.prisma.classification.groupBy({
          by: ['siteId'],
          where: { OR: [{ siteId: { in: ids } }, { siteId: null }], isActive: true },
          _count: { _all: true },
        }),
        this.prisma.breakConfig.groupBy({
          by: ['siteId'],
          where: { OR: [{ siteId: { in: ids } }, { siteId: null }], isActive: true },
          _count: { _all: true },
        }),
        this.prisma.heatHourlyRecord.groupBy({
          by: ['siteId'],
          where: { siteId: { in: ids } },
          _count: { _all: true },
          _max: { recordedAt: true },
        }),
        // 첫 작업 기록: 해당 센터 작업자가 시작한 WorkItem 이 1건이라도 있는 siteId 목록
        this.prisma.worker.findMany({
          where: { siteId: { in: ids }, startedWorkItems: { some: {} } },
          select: { siteId: true },
          distinct: ['siteId'],
        }),
      ]);

    const adminCount = new Map<string, number>();
    const workerCount = new Map<string, number>();
    for (const group of workerGroups) {
      if (!group.siteId) continue;
      const target = group.role === 'WORKER' ? workerCount : adminCount;
      target.set(group.siteId, (target.get(group.siteId) ?? 0) + group._count._all);
    }
    let globalClassCount = 0;
    const classCount = new Map<string, number>();
    for (const group of classGroups) {
      if (group.siteId) classCount.set(group.siteId, group._count._all);
      else globalClassCount = group._count._all;
    }
    let globalBreakCount = 0;
    const breakCount = new Map<string, number>();
    for (const group of breakGroups) {
      if (group.siteId) breakCount.set(group.siteId, group._count._all);
      else globalBreakCount = group._count._all;
    }
    const heatBySite = new Map<string, { count: number; last: Date | null }>();
    for (const group of heatGroups) {
      if (!group.siteId) continue;
      heatBySite.set(group.siteId, {
        count: group._count._all,
        last: group._max.recordedAt ?? null,
      });
    }
    const workedSet = new Set(
      workedSites.map((row) => row.siteId).filter((id): id is string => !!id),
    );

    for (const site of sites) {
      const settings = settingsMap.get(site.id) ?? {};
      const coords = this.coordsFromSettings(settings);
      const admins = adminCount.get(site.id) ?? 0;
      const workers = workerCount.get(site.id) ?? 0;
      const classes = (classCount.get(site.id) ?? 0) + globalClassCount;
      const breaks = (breakCount.get(site.id) ?? 0) + globalBreakCount;
      const heat = heatBySite.get(site.id) ?? { count: 0, last: null };
      const alertEmail = String(settings.alertEmail ?? '').trim();
      const prefix = String(settings.workerCodePrefix ?? '').trim();
      const worked = workedSet.has(site.id);

      const required: ReadinessItem[] = [
        {
          key: 'coords',
          label: '날씨 좌표 설정',
          ok: coords.ok,
          detail: coords.ok
            ? `위도 ${coords.lat}, 경도 ${coords.lon}`
            : '미설정 — 대구 기본 좌표로 폴백 중',
        },
        {
          key: 'admin',
          label: '관리자 계정',
          ok: admins > 0,
          detail: admins > 0 ? `관리자/반장 ${admins}명` : '활성 관리자/반장 없음',
        },
        {
          key: 'classification',
          label: '분류 설정',
          ok: classes > 0,
          detail: classes > 0 ? `활성 분류 ${classes}개` : '활성 분류 없음',
        },
        {
          key: 'tablet',
          label: '태블릿 첫 보고',
          ok: heat.count > 0,
          detail: heat.last
            ? `마지막 보고 ${this.kstDateTime(heat.last)}`
            : '체감온도 보고 기록 없음',
        },
      ];
      const optional: ReadinessItem[] = [
        {
          key: 'workers',
          label: '작업자 등록',
          ok: workers > 0,
          detail: workers > 0 ? `활성 작업자 ${workers}명` : '등록된 작업자 없음',
        },
        {
          key: 'break',
          label: '휴게시간 설정',
          ok: breaks > 0,
          detail: breaks > 0 ? `활성 휴게 ${breaks}개` : '휴게시간 없음 (순작업시간 차감 안 됨)',
        },
        {
          key: 'alertEmail',
          label: '알림 이메일',
          ok: alertEmail.length > 0,
          detail: alertEmail || '미설정 (기본 수신처로 발송)',
        },
        {
          key: 'workerCodePrefix',
          label: '사번 접두어',
          ok: prefix.length > 0,
          detail: prefix || '미설정 (센터 간 사번 충돌 주의)',
        },
        {
          key: 'firstWork',
          label: '첫 작업 기록',
          ok: worked,
          detail: worked ? '작업 기록 있음' : '작업 기록 없음',
        },
      ];

      result.set(site.id, {
        siteId: site.id,
        name: site.name,
        code: site.code,
        required,
        optional,
        requiredOk: required.filter((item) => item.ok).length,
        requiredTotal: required.length,
      });
    }
    return result;
  }

  // ══════════════════════════════════════════════
  // #30 센터 라이브 보드 (MASTER)
  // ══════════════════════════════════════════════

  /**
   * 최상위 활성 센터별 실시간 현황 — 오늘(KST) 작업 수(VOID 제외), 진행중(ACTIVE) 수,
   * 마지막 체감온도 보고 시각/단계, 좌표 설정 여부, 근무시간.
   * HeatHourlyRecord siteId NULL 행은 어느 센터에도 귀속하지 않음.
   */
  async getLiveBoard() {
    const now = new Date();
    const todayStart = kstStartOfDay(this.kstDateKey(now));

    const sites = await this.prisma.site.findMany({
      where: { parentSiteId: null, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { createdAt: 'asc' },
    });
    if (sites.length === 0) return [];
    const siteIds = sites.map((site) => site.id);

    const [settingsMap, workers, heatMax] = await Promise.all([
      this.loadTenantSettingsMap(siteIds),
      this.prisma.worker.findMany({
        where: { siteId: { in: siteIds } },
        select: { id: true, siteId: true },
      }),
      this.prisma.heatHourlyRecord.groupBy({
        by: ['siteId'],
        where: { siteId: { in: siteIds } },
        _max: { recordedAt: true },
      }),
    ]);

    const workerSite = new Map<string, string>();
    for (const worker of workers) {
      if (worker.siteId) workerSite.set(worker.id, worker.siteId);
    }
    const workerIds = workers.map((worker) => worker.id);
    const latestPairs = heatMax.flatMap((group) =>
      group.siteId && group._max.recordedAt
        ? [{ siteId: group.siteId, recordedAt: group._max.recordedAt }]
        : [],
    );

    const [todayGroups, activeGroups, latestHeatRows] = await Promise.all([
      this.prisma.workItem.groupBy({
        by: ['startedByWorkerId'],
        where: {
          startedByWorkerId: { in: workerIds },
          startedAt: { gte: todayStart },
          status: { not: 'VOID' },
        },
        _count: { _all: true },
      }),
      this.prisma.workItem.groupBy({
        by: ['startedByWorkerId'],
        where: { startedByWorkerId: { in: workerIds }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      latestPairs.length > 0
        ? this.prisma.heatHourlyRecord.findMany({
            where: { OR: latestPairs },
            select: { siteId: true, recordedAt: true, level: true },
          })
        : Promise.resolve(
            [] as Array<{ siteId: string | null; recordedAt: Date; level: string }>,
          ),
    ]);

    const todayBySite = new Map<string, number>();
    for (const group of todayGroups) {
      const siteId = workerSite.get(group.startedByWorkerId);
      if (!siteId) continue;
      todayBySite.set(siteId, (todayBySite.get(siteId) ?? 0) + group._count._all);
    }
    const activeBySite = new Map<string, number>();
    for (const group of activeGroups) {
      const siteId = workerSite.get(group.startedByWorkerId);
      if (!siteId) continue;
      activeBySite.set(siteId, (activeBySite.get(siteId) ?? 0) + group._count._all);
    }
    const heatBySite = new Map<string, { recordedAt: Date; level: string }>();
    for (const row of latestHeatRows) {
      if (row.siteId) heatBySite.set(row.siteId, row);
    }

    return sites.map((site) => {
      const settings = settingsMap.get(site.id) ?? {};
      const heat = heatBySite.get(site.id) ?? null;
      const workStartHour = this.resolveWorkStartHour(settings.workStartHour);
      return {
        siteId: site.id,
        name: site.name,
        code: site.code,
        todayCount: todayBySite.get(site.id) ?? 0,
        activeCount: activeBySite.get(site.id) ?? 0,
        lastHeatReportAt: heat?.recordedAt ?? null,
        heatLevel: heat?.level ?? null,
        coordsSet: this.coordsFromSettings(settings).ok,
        workStartHour,
        workEndHour: this.resolveWorkEndHour(settings.workEndHour, workStartHour),
      };
    });
  }

  /** TenantSettings.workEndHour → 1~24 정수 && 시작 시각 이후만 허용, 아니면 기본 18 */
  private resolveWorkEndHour(raw: unknown, workStartHour: number): number {
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= 24 && value > workStartHour) {
      return value;
    }
    return Math.max(this.DEFAULT_WORK_END_HOUR, workStartHour + 1);
  }

  // ══════════════════════════════════════════════
  // #42 센터 간 기간 비교
  // ══════════════════════════════════════════════

  /** from/to (KST 'YYYY-MM-DD') → 기간. 생략 시 이번 달(KST) 1일~말일 */
  private resolvePeriod(from?: string, to?: string): ResolvedPeriod {
    if ((from && !DATE_KEY_RE.test(from)) || (to && !DATE_KEY_RE.test(to))) {
      throw new BadRequestException('from/to는 YYYY-MM-DD 형식이어야 합니다');
    }
    const todayKey = this.kstDateKey(new Date());
    const [year, month] = todayKey.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthPrefix = todayKey.slice(0, 7);
    const resolvedFrom = from || `${monthPrefix}-01`;
    const resolvedTo = to || `${monthPrefix}-${this.pad2(lastDay)}`;
    if (resolvedFrom > resolvedTo) {
      throw new BadRequestException('from은 to보다 이전이어야 합니다');
    }
    const { fromDate, toDate } = kstDateRange(resolvedFrom, resolvedTo);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('유효하지 않은 날짜입니다');
    }
    return { from: resolvedFrom, to: resolvedTo, fromDate, toDate };
  }

  private emptyPeriodAggregate(): PeriodAggregate {
    return {
      count: 0,
      volume: 0,
      quantity: 0,
      perWorker: null,
      avgNetMinutes: null,
      stuckCount: 0,
      activeWorkerCount: 0,
      endedCount: 0,
    };
  }

  /**
   * 사이트별 기간 집계 (배치) — 작업자 목록 1회 + workItem groupBy 2회 + 종료 행 1회.
   * 작업자 siteId 로 엄격 귀속(OR-null 금지). siteId NULL 작업자는 UNASSIGNED_KEY 단일 행
   * (NULL 작업자가 없으면 해당 키 없음). 순작업시간은 calcNetWorkMinutes + 사이트별 휴게 차감.
   */
  private async computePeriodAggregates(
    siteIds: string[],
    range: ResolvedPeriod,
  ): Promise<Map<string, PeriodAggregate>> {
    const result = new Map<string, PeriodAggregate>();
    for (const id of siteIds) result.set(id, this.emptyPeriodAggregate());

    const workers = await this.prisma.worker.findMany({
      where: {
        OR: [...(siteIds.length > 0 ? [{ siteId: { in: siteIds } }] : []), { siteId: null }],
        role: { notIn: ['MASTER'] },
      },
      select: { id: true, siteId: true, status: true, role: true, employeeCode: true },
    });

    const keyOf = (siteId: string | null) => siteId ?? UNASSIGNED_KEY;
    const workerKey = new Map<string, string>();
    const activeCounts = new Map<string, number>();
    let hasUnassigned = false;
    for (const worker of workers) {
      const key = keyOf(worker.siteId);
      workerKey.set(worker.id, key);
      if (!worker.siteId) hasUnassigned = true;
      const isFieldWorker =
        worker.status === 'ACTIVE' &&
        !['MASTER', 'ADMIN'].includes(worker.role) &&
        !worker.employeeCode.includes(KIOSK_CODE_SUFFIX);
      if (isFieldWorker) activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
    }
    if (hasUnassigned) result.set(UNASSIGNED_KEY, this.emptyPeriodAggregate());

    const workerIds = workers.map((worker) => worker.id);
    if (workerIds.length === 0) return result;

    const stuckThreshold = new Date(Date.now() - this.LONG_RUNNING_THRESHOLD_HOURS * HOUR_MS);
    const stuckUpper = new Date(Math.min(range.toDate.getTime(), stuckThreshold.getTime()));
    const inRange = { gte: range.fromDate, lte: range.toDate };

    const [sumGroups, endedRows, breaks] = await Promise.all([
      this.prisma.workItem.groupBy({
        by: ['startedByWorkerId'],
        where: {
          startedByWorkerId: { in: workerIds },
          startedAt: inRange,
          status: { not: 'VOID' },
        },
        _count: { _all: true },
        _sum: { volume: true, quantity: true },
      }),
      this.prisma.workItem.findMany({
        where: { startedByWorkerId: { in: workerIds }, startedAt: inRange, status: 'ENDED' },
        select: { startedByWorkerId: true, startedAt: true, endedAt: true, notes: true },
      }),
      loadBreakConfigResolver(this.prisma, [...siteIds, null]),
    ]);
    const stuckGroups =
      stuckUpper >= range.fromDate
        ? await this.prisma.workItem.groupBy({
            by: ['startedByWorkerId'],
            where: {
              startedByWorkerId: { in: workerIds },
              status: 'ACTIVE',
              startedAt: { gte: range.fromDate, lte: stuckUpper },
            },
            _count: { _all: true },
          })
        : [];

    for (const group of sumGroups) {
      const agg = result.get(workerKey.get(group.startedByWorkerId) ?? '');
      if (!agg) continue;
      agg.count += group._count._all;
      agg.volume += Number(group._sum.volume ?? 0);
      agg.quantity += Number(group._sum.quantity ?? 0);
    }
    for (const group of stuckGroups) {
      const agg = result.get(workerKey.get(group.startedByWorkerId) ?? '');
      if (!agg) continue;
      agg.stuckCount += group._count._all;
    }
    const netSum = new Map<string, { sum: number; count: number }>();
    for (const row of endedRows) {
      const key = workerKey.get(row.startedByWorkerId);
      if (!key) continue;
      const minutes = calcNetWorkMinutes(
        row.startedAt,
        row.endedAt,
        row.notes,
        breaks.forSite(key === UNASSIGNED_KEY ? null : key),
      );
      const entry = netSum.get(key) ?? { sum: 0, count: 0 };
      entry.sum += minutes;
      entry.count += 1;
      netSum.set(key, entry);
    }

    result.forEach((agg, key) => {
      agg.activeWorkerCount = activeCounts.get(key) ?? 0;
      agg.perWorker =
        agg.activeWorkerCount > 0
          ? Number((agg.count / agg.activeWorkerCount).toFixed(1))
          : null;
      const net = netSum.get(key);
      agg.endedCount = net?.count ?? 0;
      agg.avgNetMinutes = net && net.count > 0 ? Math.round(net.sum / net.count) : null;
      agg.volume = Number(agg.volume.toFixed(2));
    });
    return result;
  }

  /** #45 TenantSettings JSON → 연락처·메모 (빈 문자열은 null) */
  private contactFromSettings(settings: Record<string, unknown>): SiteContact {
    const text = (value: unknown): string | null => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : null;
    };
    return {
      contactName: text(settings.contactName),
      contactPhone: text(settings.contactPhone),
      tabletDevice: text(settings.tabletDevice),
      tabletInstalledAt: text(settings.tabletInstalledAt),
      siteMemo: text(settings.siteMemo),
    };
  }

  async getOperationsConsole(siteId?: string) {
    const overview = await this.getCustomerOverview(siteId);
    const lockedWorkers = await this.getLockedWorkers(siteId);
    const failedLogins = await this.getRecentFailedLogins(siteId);

    const actions = overview.sites
      .flatMap((site) => {
        const siteActions: Array<{
          id: string;
          severity: 'critical' | 'warning' | 'info';
          type: string;
          siteId: string;
          siteName: string;
          title: string;
          description: string;
          href: string;
        }> = [];

        if (site.longRunningActiveCount > 0) {
          siteActions.push({
            id: `${site.id}-long-running`,
            severity: 'critical',
            type: 'long_running',
            siteId: site.id,
            siteName: site.name,
            title: '장시간 미종료 작업 확인',
            description: `${site.longRunningActiveCount}건의 장시간 진행 작업이 있습니다.`,
            href: '/work-items',
          });
        }

        if (['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(site.subscriptionStatus)) {
          siteActions.push({
            id: `${site.id}-subscription`,
            severity: 'critical',
            type: 'subscription',
            siteId: site.id,
            siteName: site.name,
            title: '구독 상태 점검 필요',
            description: `현재 구독 상태는 ${site.subscriptionStatus} 입니다.`,
            href: '/billing',
          });
        }

        if (site.onboarding.status !== 'COMPLETED') {
          siteActions.push({
            id: `${site.id}-onboarding`,
            severity: 'warning',
            type: 'onboarding',
            siteId: site.id,
            siteName: site.name,
            title: '개통 준비 미완료',
            // #29 준비도 기반: step = 필수 충족 수 / totalSteps = 필수 항목 수
            description: `필수 항목 ${site.onboarding.step}/${site.onboarding.totalSteps} 충족 (${site.onboarding.progressPercent}%) — 미충족: ${
              site.onboarding.required
                .filter((item) => !item.ok)
                .map((item) => item.label)
                .join(', ') || '-'
            }`,
            href: '/onboarding',
          });
        }

        if (site.openCaseCount > 0) {
          siteActions.push({
            id: `${site.id}-support`,
            severity: site.p1OpenCaseCount > 0 ? 'critical' : 'warning',
            type: 'support',
            siteId: site.id,
            siteName: site.name,
            title: '열린 지원 케이스 확인',
            description: `미해결 지원 케이스 ${site.openCaseCount}건이 있습니다.`,
            href: '/support-cases',
          });
        }

        if (site.daysSinceLastActivity !== null && site.daysSinceLastActivity >= 7) {
          siteActions.push({
            id: `${site.id}-inactive`,
            severity: 'warning',
            type: 'adoption',
            siteId: site.id,
            siteName: site.name,
            title: '활동 저하 고객',
            description: `마지막 활동 후 ${site.daysSinceLastActivity}일이 지났습니다.`,
            href: '/customer-overview',
          });
        }

        return siteActions;
      })
      .sort((a, b) => this.getSeverityRank(a.severity) - this.getSeverityRank(b.severity))
      .slice(0, 12);

    const last30dWorkItems = overview.sites.reduce(
      (sum, site) => sum + site.metrics.last30dWorkItems,
      0,
    );
    const previous30dWorkItems = overview.sites.reduce(
      (sum, site) => sum + site.metrics.previous30dWorkItems,
      0,
    );
    const trendPercent = this.calculateTrend(last30dWorkItems, previous30dWorkItems);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalSites: overview.stats.totalSites,
        attentionSites: overview.stats.attentionSiteCount,
        openSupportCases: overview.stats.openCaseCount,
        subscriptionRisks: overview.stats.subscriptionRiskCount,
        pendingOnboarding: overview.stats.onboardingIncompleteCount,
        lowActivitySites: overview.stats.lowActivityCount,
        lockedAccounts: lockedWorkers.length,
        failedLogins24h: failedLogins.length,
      },
      valueMetrics: {
        last30dWorkItems,
        previous30dWorkItems,
        trendPercent,
        averageDailyWorkItems:
          Number((last30dWorkItems / 30).toFixed(1)) || 0,
        activeSiteRatio:
          overview.stats.totalSites === 0
            ? 0
            : Number(
                (
                  (overview.stats.activeSites / overview.stats.totalSites) *
                  100
                ).toFixed(1),
              ),
      },
      security: {
        lockedWorkers,
        recentFailedLogins: failedLogins.slice(0, 10),
      },
      actions,
    };
  }

  // ══════════════════════════════════════════════
  // #31 아침 운영 다이제스트 (MASTER 운영자용, 크론 ops-digest → 발송은 크론이 담당)
  // ══════════════════════════════════════════════

  /**
   * 최상위 활성 센터(parentSiteId null, isActive)별로 아침 운영 이상을 점검해 메일 본문을 만든다.
   * 점검 항목(센터별 try/catch — 한 센터 실패가 나머지를 막지 않음):
   *  - 구독 비활성(EXPIRED/SUSPENDED/CANCELLED): 표기만 하고 태블릿/작업 점검은 생략
   *  - 체험 만료 D-3 이내
   *  - 날씨 좌표(latitude/longitude) 미설정 → 대구 기본 좌표 폴백 중
   *  - 태블릿 미보고: 근무 시작(workStartHour, 기본 8시) 이후 HeatHourlyRecord 보고 없음/중단
   *  - 오늘 작업 0건: 근무 시작 + 유예(2h) 경과 센터만
   *  - 장시간 미종료: ACTIVE 12h+
   * siteId NULL 데이터(레거시 작업자/기록)는 첫 센터(가장 오래된 최상위 활성 센터)에만 귀속.
   * 이상 0이면 hasIssues=false (크론이 발송 생략 판단).
   */
  async buildOpsDigest(): Promise<{ hasIssues: boolean; subject: string; html: string }> {
    const now = new Date();
    const todayKey = this.kstDateKey(now);
    const todayStart = kstStartOfDay(todayKey);

    const sites = await this.prisma.site.findMany({
      where: { parentSiteId: null, isActive: true },
      include: {
        subscriptions: {
          include: { plan: { select: { name: true, code: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        tenantSettings: { select: { settings: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const firstSiteId = sites[0]?.id ?? null;

    const rows: DigestSiteRow[] = [];
    for (const site of sites) {
      const settings = this.safeParseJson(site.tenantSettings?.settings);
      const workStartHour = this.resolveWorkStartHour(settings.workStartHour);
      const subscription = site.subscriptions[0] ?? null;
      const subscriptionStatus = String(subscription?.status || 'NONE').toUpperCase();
      const row: DigestSiteRow = {
        siteId: site.id,
        siteName: site.name,
        siteCode: site.code,
        subscriptionStatus,
        workStartHour,
        issues: [],
      };
      try {
        row.issues = await this.collectDigestIssues({
          siteId: site.id,
          settings,
          workStartHour,
          subscriptionStatus,
          trialEndsAt: subscription?.trialEndsAt ?? null,
          includeNullSite: site.id === firstSiteId,
          now,
          todayStart,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[ops-digest] 센터 점검 실패 (site ${site.id} ${site.name}): ${message}`);
        row.issues = [
          {
            type: 'check_failed',
            severity: 'warning',
            title: '점검 실패',
            detail: `점검 중 오류가 발생했습니다: ${message}`,
          },
        ];
      }
      rows.push(row);
    }

    const issueRows = rows.filter((row) => row.issues.length > 0);
    const healthyRows = rows.filter((row) => row.issues.length === 0);
    const hasIssues = issueRows.length > 0;
    const subject = hasIssues
      ? `[새롬GLS] 아침 운영 점검 — 이상 ${issueRows.length}센터`
      : '[새롬GLS] 아침 운영 점검 — 이상 없음';
    const html = this.renderOpsDigestHtml({
      now,
      todayKey,
      totalSites: rows.length,
      issueRows,
      healthyRows,
    });

    this.logger.log(
      `[ops-digest] sites=${rows.length} issues=${issueRows.length} (${issueRows
        .map((row) => `${row.siteName}:${row.issues.length}`)
        .join(', ') || '-'})`,
    );

    return { hasIssues, subject, html };
  }

  /** 센터 1곳의 이상 항목 수집 (buildOpsDigest 전용) */
  private async collectDigestIssues(input: {
    siteId: string;
    settings: Record<string, unknown>;
    workStartHour: number;
    subscriptionStatus: string;
    trialEndsAt: Date | null;
    includeNullSite: boolean;
    now: Date;
    todayStart: Date;
  }): Promise<DigestIssue[]> {
    const { siteId, settings, workStartHour, subscriptionStatus, trialEndsAt, now, todayStart } =
      input;
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const issues: DigestIssue[] = [];

    const workStartAt = new Date(todayStart.getTime() + workStartHour * HOUR);
    const graceDeadline = new Date(workStartAt.getTime() + this.DIGEST_GRACE_HOURS * HOUR);
    const stuckThreshold = new Date(now.getTime() - this.DIGEST_STUCK_HOURS * HOUR);

    // 1) 구독 비활성 — MASTER 다이제스트에는 포함하되 운영 점검은 생략
    const operational = !DIGEST_INACTIVE_SUBSCRIPTION.includes(subscriptionStatus);
    if (!operational) {
      issues.push({
        type: 'subscription',
        severity: 'critical',
        title: '구독 비활성',
        detail: `구독 상태 ${subscriptionStatus} — 태블릿/작업 점검은 생략했습니다.`,
      });
    }

    // 2) 체험 만료 D-3 이내 (이미 지난 경우도 표기 — subscription-check 크론 전이 대기 중)
    if (subscriptionStatus === 'TRIAL' && trialEndsAt) {
      const daysLeft = Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY);
      if (daysLeft <= this.DIGEST_TRIAL_WARN_DAYS) {
        const endsKey = this.kstDateKey(trialEndsAt);
        issues.push({
          type: 'trial',
          severity: daysLeft <= 1 ? 'critical' : 'warning',
          title: '체험 만료 임박',
          detail:
            daysLeft >= 0
              ? `D-${daysLeft} (체험 종료 ${endsKey} KST) — 전환 안내 필요`
              : `체험 종료일(${endsKey} KST) 경과 — 상태 전이 확인 필요`,
        });
      }
    }

    // 3) 날씨 좌표 미설정 (heat-alerts getSiteConfig 와 동일 판정: 유한값 && 0 아님)
    const lat = Number(settings.latitude);
    const lon = Number(settings.longitude);
    const coordsResolved =
      Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;
    if (!coordsResolved) {
      issues.push({
        type: 'coords',
        severity: 'warning',
        title: '날씨 좌표 미설정',
        detail: '폭염(체감온도) 판정이 대구 기본 좌표로 폴백 중 — 설정에서 위경도를 입력하세요.',
      });
    }

    if (!operational) {
      return issues;
    }

    // siteId NULL 데이터는 첫 센터에만 귀속
    const heatScope: Prisma.HeatHourlyRecordWhereInput = input.includeNullSite
      ? { OR: [{ siteId }, { siteId: null }] }
      : { siteId };
    const workScope: Prisma.WorkItemWhereInput = {
      startedByWorker: input.includeNullSite
        ? { OR: [{ siteId }, { siteId: null }] }
        : { siteId },
    };

    const [latestHeat, todayWorkCount, stuckCount] = await Promise.all([
      this.prisma.heatHourlyRecord.findFirst({
        where: { ...heatScope, recordedAt: { gte: todayStart } },
        orderBy: { recordedAt: 'desc' },
        select: { recordedAt: true },
      }),
      this.prisma.workItem.count({
        where: { ...workScope, startedAt: { gte: todayStart } },
      }),
      this.prisma.workItem.count({
        where: { ...workScope, status: 'ACTIVE', startedAt: { lte: stuckThreshold } },
      }),
    ]);

    // 4) 태블릿 미보고 — 근무 시작 이후에만 판정.
    //    기준 시각 = max(min(근무시작+유예, 현재-1h), 근무시작):
    //    · 유예 마감이 지났으면 "오늘 max recordedAt < workStartHour+2h" (계약 그대로)
    //    · 유예 마감 전(예: 09:30 크론, 8시 시작)은 최근 1시간 내 보고가 없으면 미보고
    //      (HeatHourlyRecord 는 정시 절삭 + 30분 주기 보고이므로 1시간 무보고 = 앱 중단)
    if (now >= workStartAt) {
      const cutoffMs = Math.max(
        Math.min(graceDeadline.getTime(), now.getTime() - HOUR),
        workStartAt.getTime(),
      );
      const lastReportedAt = latestHeat?.recordedAt ?? null;
      if (!lastReportedAt || lastReportedAt.getTime() < cutoffMs) {
        issues.push({
          type: 'tablet',
          severity: 'critical',
          title: '태블릿 미보고',
          detail: lastReportedAt
            ? `오늘 마지막 체감온도 보고 ${this.kstTime(lastReportedAt)} 이후 중단 (근무 시작 ${this.pad2(workStartHour)}:00)`
            : `오늘 체감온도 보고 없음 — 태블릿 앱 미실행 가능성 (근무 시작 ${this.pad2(workStartHour)}:00)`,
        });
      }
    }

    // 5) 오늘 작업 0건 — 근무 시작 + 유예 경과 센터만
    if (now >= graceDeadline && todayWorkCount === 0) {
      issues.push({
        type: 'no_work',
        severity: 'warning',
        title: '오늘 작업 0건',
        detail: `근무 시작(${this.pad2(workStartHour)}:00) 후 ${this.DIGEST_GRACE_HOURS}시간이 지났으나 작업 기록이 없습니다.`,
      });
    }

    // 6) 장시간 미종료 (ACTIVE 12h+)
    if (stuckCount > 0) {
      issues.push({
        type: 'stuck',
        severity: 'critical',
        title: '장시간 미종료 작업',
        detail: `${this.DIGEST_STUCK_HOURS}시간 이상 진행 중(ACTIVE)인 작업 ${stuckCount}건 — 종료 누락 확인 필요`,
      });
    }

    return issues;
  }

  /** TenantSettings.workStartHour → 0~23 정수만 허용, 아니면 기본 8 */
  private resolveWorkStartHour(raw: unknown): number {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value <= 23
      ? value
      : this.DIGEST_DEFAULT_WORK_START_HOUR;
  }

  /** 다이제스트 메일 본문 (간단한 인라인 스타일 HTML 표) */
  private renderOpsDigestHtml(input: {
    now: Date;
    todayKey: string;
    totalSites: number;
    issueRows: DigestSiteRow[];
    healthyRows: DigestSiteRow[];
  }): string {
    const { now, todayKey, totalSites, issueRows, healthyRows } = input;
    const esc = (value: unknown) => this.escapeHtml(value);
    const webBase = process.env.WEB_BASE_URL || 'https://sae-work.com';
    const cell = 'padding:8px 12px;border:1px solid #E2E8F0;font-size:13px;color:#0F172A;vertical-align:top;';
    const head = 'padding:8px 12px;border:1px solid #E2E8F0;font-size:12px;color:#475569;background:#F8FAFC;text-align:left;';
    const severityBadge = (severity: DigestSeverity) =>
      severity === 'critical'
        ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#FEE2E2;color:#B91C1C;font-size:11px;font-weight:600;">긴급</span>'
        : '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#FEF3C7;color:#B45309;font-size:11px;font-weight:600;">주의</span>';

    const criticalCount = issueRows.reduce(
      (sum, row) => sum + row.issues.filter((issue) => issue.severity === 'critical').length,
      0,
    );
    const warningCount = issueRows.reduce(
      (sum, row) => sum + row.issues.filter((issue) => issue.severity === 'warning').length,
      0,
    );

    const tableRows = issueRows
      .map((row) =>
        row.issues
          .map((issue, index) => {
            const siteCell =
              index === 0
                ? `<td style="${cell}" rowspan="${row.issues.length}"><b>${esc(row.siteName)}</b><br/><span style="color:#94A3B8;font-size:11px;">${esc(row.siteCode)} · 구독 ${esc(row.subscriptionStatus)} · 근무 ${this.pad2(row.workStartHour)}:00~</span></td>`
                : '';
            return `<tr>${siteCell}<td style="${cell}white-space:nowrap;">${severityBadge(issue.severity)} ${esc(issue.title)}</td><td style="${cell}">${esc(issue.detail)}</td></tr>`;
          })
          .join(''),
      )
      .join('');

    const issueSection =
      issueRows.length > 0
        ? `<table style="border-collapse:collapse;width:100%;margin-top:12px;">
        <thead><tr><th style="${head}">센터</th><th style="${head}">항목</th><th style="${head}">내용</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`
        : `<p style="margin:12px 0;padding:12px;background:#ECFDF5;color:#047857;border-radius:6px;font-size:13px;">모든 센터가 정상입니다.</p>`;

    const healthySection =
      healthyRows.length > 0
        ? `<p style="margin:14px 0 0;font-size:12px;color:#475569;">정상 센터 ${healthyRows.length}곳: ${healthyRows
            .map((row) => esc(row.siteName))
            .join(', ')}</p>`
        : '';

    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;max-width:760px;margin:0 auto;color:#0F172A;">
  <h2 style="margin:0 0 4px;font-size:18px;">아침 운영 점검 — ${esc(todayKey)} (KST)</h2>
  <p style="margin:0 0 12px;font-size:13px;color:#475569;">최상위 활성 센터 ${totalSites}곳 중 이상 <b style="color:${issueRows.length > 0 ? '#B91C1C' : '#047857'};">${issueRows.length}곳</b>
    (긴급 ${criticalCount}건 · 주의 ${warningCount}건) · 기준 시각 ${esc(this.kstDateTime(now))}</p>
  ${issueSection}
  ${healthySection}
  <p style="margin:18px 0 0;font-size:12px;color:#94A3B8;">
    점검 기준: 태블릿 미보고(근무 시작 이후 체감온도 보고 없음/중단) · 오늘 작업 0건(근무 시작+${this.DIGEST_GRACE_HOURS}h 경과) · 체험 만료 D-${this.DIGEST_TRIAL_WARN_DAYS} 이내 · 날씨 좌표 미설정 · 장시간 미종료(ACTIVE ${this.DIGEST_STUCK_HOURS}h+)<br/>
    운영 콘솔: <a href="${esc(webBase)}/customer-overview" style="color:#2C6FB0;">${esc(webBase)}/customer-overview</a> · 새롬GLS 작업현황 공유 시스템 자동 발송
  </p>
</div>`;
  }

  /** KST 날짜 키 'YYYY-MM-DD' */
  private kstDateKey(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** KST 'YYYY-MM-DD HH:mm' */
  private kstDateTime(date: Date): string {
    const iso = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }

  /** KST 'HH:mm' */
  private kstTime(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  }

  private pad2(value: number): string {
    return String(value).padStart(2, '0');
  }

  /** 메일 본문 HTML 이스케이프 (센터명 등 사용자 입력값) */
  private escapeHtml(value: unknown): string {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
    };
    return String(value ?? '').replace(/[<>&"]/g, (c) => map[c] ?? c);
  }

  async getSiteTemplates() {
    return this.prisma.siteTemplate.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSiteFromTemplate(dto: CreateSiteFromTemplateDto) {
    const template = await this.prisma.siteTemplate.findUnique({
      where: { id: dto.templateId },
    });
    if (!template) {
      throw new NotFoundException('사이트 템플릿을 찾을 수 없습니다');
    }

    const existing = await this.prisma.site.findUnique({
      where: { code: dto.siteCode },
    });
    if (existing) {
      throw new BadRequestException('이미 존재하는 사이트 코드입니다');
    }

    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.create({
        data: {
          name: dto.siteName,
          code: dto.siteCode,
          isActive: true,
        },
      });

      let classifications: Array<{
        code: string;
        displayName: string;
        sortOrder?: number;
      }> = [];
      try {
        classifications = JSON.parse(template.classificationsJson);
      } catch {
        classifications = [];
      }

      if (classifications.length > 0) {
        await tx.classification.createMany({
          data: classifications.map((item, index) => ({
            code: `${dto.siteCode}_${item.code}`,
            displayName: item.displayName,
            sortOrder: item.sortOrder ?? index,
            siteId: site.id,
          })),
        });
      }

      let breakConfigs: Array<{
        label: string;
        startHour: number;
        startMin: number;
        endHour: number;
        endMin: number;
      }> = [];
      try {
        breakConfigs = JSON.parse(template.breakConfigsJson);
      } catch {
        breakConfigs = [];
      }

      if (breakConfigs.length > 0) {
        await tx.breakConfig.createMany({
          data: breakConfigs.map((item, index) => ({
            label: item.label,
            startHour: item.startHour,
            startMin: item.startMin,
            endHour: item.endHour,
            endMin: item.endMin,
            siteId: site.id,
            sortOrder: index,
          })),
        });
      }

      await tx.onboardingRun.create({
        data: {
          siteId: site.id,
          step: 1,
          totalSteps: 9,
          status: 'IN_PROGRESS',
        },
      });

      await tx.tenantSettings.create({
        data: {
          siteId: site.id,
          settings: JSON.stringify({
            timezone: 'Asia/Seoul',
            language: 'ko',
            workStartHour: 8,
            workEndHour: 18,
            kioskMode: true,
            autoScreensaverSeconds: 60,
            noticeMessage: '',
          }),
        },
      });

      return {
        site,
        classificationsCreated: classifications.length,
        breakConfigsCreated: breakConfigs.length,
        message: `사이트 "${dto.siteName}"이(가) 성공적으로 생성되었습니다`,
      };
    });
  }

  async getSupportCases(siteId?: string, status?: string) {
    const where: Prisma.SupportCaseWhereInput = {};
    if (siteId) where.siteId = siteId;
    if (status) where.status = status;

    return this.prisma.supportCase.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSupportCase(dto: CreateSupportCaseDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    return this.prisma.supportCase.create({
      data: {
        siteId: dto.siteId,
        reporterId: dto.reporterId || null,
        severity: dto.severity || 'P3',
        title: dto.title,
        description: dto.description || null,
        status: 'OPEN',
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async resolveSupportCase(id: string, dto: ResolveSupportCaseDto) {
    const supportCase = await this.prisma.supportCase.findUnique({
      where: { id },
    });
    if (!supportCase) {
      throw new NotFoundException('지원 케이스를 찾을 수 없습니다');
    }
    if (supportCase.status === 'RESOLVED' || supportCase.status === 'CLOSED') {
      throw new BadRequestException('이미 해결된 케이스입니다');
    }

    return this.prisma.supportCase.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution: dto.resolution,
        resolvedAt: new Date(),
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
  }

  async generateUsageSnapshot(dto: GenerateUsageSnapshotDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const [year, month] = dto.month.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1);

    const workerCount = await this.prisma.worker.count({
      where: {
        OR: [{ siteId: dto.siteId }, { siteId: null }],
        status: 'ACTIVE',
        role: { notIn: ['MASTER'] },
      },
    });

    const workItems = await this.prisma.workItem.findMany({
      where: {
        startedByWorker: {
          OR: [{ siteId: dto.siteId }, { siteId: null }],
        },
        startedAt: { gte: monthStart, lt: monthEnd },
      },
      select: { volume: true, quantity: true },
    });

    const workItemCount = workItems.length;
    const totalVolume = workItems.reduce(
      (sum, item) => sum + Number(item.volume),
      0,
    );
    const totalQuantity = workItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    return this.prisma.usageSnapshot.upsert({
      where: {
        siteId_month: {
          siteId: dto.siteId,
          month: dto.month,
        },
      },
      update: {
        workerCount,
        workItemCount,
        totalVolume,
        totalQuantity,
      },
      create: {
        siteId: dto.siteId,
        month: dto.month,
        workerCount,
        workItemCount,
        totalVolume,
        totalQuantity,
      },
    });
  }

  async getUsageSnapshots(siteId?: string) {
    const where: Prisma.UsageSnapshotWhereInput = {};
    if (siteId) where.siteId = siteId;

    return this.prisma.usageSnapshot.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ month: 'desc' }, { siteId: 'asc' }],
    });
  }

  async getOnboardingRuns(siteId?: string) {
    const where: Prisma.OnboardingRunWhereInput = {};
    if (siteId) where.siteId = siteId;

    const runs = await this.prisma.onboardingRun.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ startedAt: 'desc' }],
    });

    return runs.map((run) => ({
      ...run,
      progressPercent:
        run.status === 'COMPLETED'
          ? 100
          : Math.round((run.step / Math.max(run.totalSteps, 1)) * 100),
    }));
  }

  async startOnboardingRun(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const existing = await this.prisma.onboardingRun.findFirst({
      where: {
        siteId,
        status: 'IN_PROGRESS',
      },
      orderBy: { startedAt: 'desc' },
    });

    if (existing) {
      return {
        ...existing,
        progressPercent: Math.round(
          (existing.step / Math.max(existing.totalSteps, 1)) * 100,
        ),
      };
    }

    const run = await this.prisma.onboardingRun.create({
      data: {
        siteId,
        step: 1,
        totalSteps: 9,
        status: 'IN_PROGRESS',
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      ...run,
      progressPercent: Math.round((run.step / run.totalSteps) * 100),
    };
  }

  async updateOnboardingRun(
    id: string,
    dto: UpdateOnboardingRunDto,
    user: JwtPayload,
  ) {
    const run = await this.prisma.onboardingRun.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });
    if (!run) {
      throw new NotFoundException('온보딩 실행 기록을 찾을 수 없습니다');
    }

    if (user.role !== 'MASTER' && run.siteId !== user.siteId) {
      throw new ForbiddenException('자신의 사이트 온보딩만 수정할 수 있습니다');
    }

    let step = dto.step ?? run.step;
    const totalSteps = dto.totalSteps ?? run.totalSteps;

    if (dto.markStepComplete) {
      step = Math.min(step + 1, totalSteps);
    }

    const status =
      dto.status ||
      (step >= totalSteps ? 'COMPLETED' : run.status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS');

    const updated = await this.prisma.onboardingRun.update({
      where: { id },
      data: {
        step,
        totalSteps,
        status,
        notes: dto.notes ?? run.notes,
        completedAt: status === 'COMPLETED' ? new Date() : null,
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      ...updated,
      progressPercent:
        status === 'COMPLETED'
          ? 100
          : Math.round((updated.step / Math.max(updated.totalSteps, 1)) * 100),
    };
  }

  async getTenantSettings(siteId?: string) {
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { siteId },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    if (!settings) {
      return {
        siteId,
        settings: {
          timezone: 'Asia/Seoul',
          language: 'ko',
          workStartHour: 8,
          workEndHour: 18,
          kioskMode: true,
          autoScreensaverSeconds: 60,
          noticeMessage: '',
        },
      };
    }

    return {
      id: settings.id,
      siteId: settings.siteId,
      site: settings.site,
      settings: this.safeParseJson(settings.settings),
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  async updateTenantSettings(
    siteId: string | undefined,
    dto: UpsertTenantSettingsDto,
  ) {
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
    });
    if (!site) {
      throw new NotFoundException('사이트를 찾을 수 없습니다');
    }

    const existing = await this.prisma.tenantSettings.findUnique({
      where: { siteId },
    });
    const current = existing ? this.safeParseJson(existing.settings) : {};
    const merged = {
      timezone: 'Asia/Seoul',
      language: 'ko',
      workStartHour: 8,
      workEndHour: 18,
      kioskMode: true,
      autoScreensaverSeconds: 60,
      noticeMessage: '',
      ...current,
      ...dto,
      ...(dto.extra || {}),
    };

    const result = await this.prisma.tenantSettings.upsert({
      where: { siteId },
      update: {
        settings: JSON.stringify(merged),
      },
      create: {
        siteId,
        settings: JSON.stringify(merged),
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      id: result.id,
      siteId: result.siteId,
      site: result.site,
      settings: merged,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  /**
   * 사이트별 운영 개요.
   * - 온보딩 판정은 #29 개통 준비도(필수 4항목)로 계산 (OnboardingRun 수동 단계 아님)
   * - #42 period: 기간 집계 (OR-null 금지, NULL 작업자는 unassigned 단일 행)
   * - #45 contact: TenantSettings 의 연락처·메모 (설정 JSON 은 1회 배치 조회)
   * 기존 30일/7일 지표는 OR-null 유지 (레거시 NULL 작업자 보호 — 비교표 아님)
   */
  private async buildSiteOverview(siteId?: string, period?: ResolvedPeriod) {
    const range = period ?? this.resolvePeriod();
    const sites = await this.prisma.site.findMany({
      where: siteId ? { id: siteId } : { parentSiteId: null },
      include: {
        subscriptions: {
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const siteIds = sites.map((site) => site.id);

    // 배치 조회: 설정 JSON → (준비도, 기간 집계)
    const settingsMap = await this.loadTenantSettingsMap(siteIds);
    const [readinessMap, periodMap] = await Promise.all([
      this.computeReadiness(sites, settingsMap),
      this.computePeriodAggregates(siteIds, range),
    ]);

    const now = new Date();
    const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const prev30Start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const longRunningThreshold = new Date(
      now.getTime() - this.LONG_RUNNING_THRESHOLD_HOURS * 60 * 60 * 1000,
    );

    const rows = await Promise.all(
      sites.map(async (site) => {
        const siteWorkerFilter: Prisma.WorkerWhereInput = {
          OR: [{ siteId: site.id }, { siteId: null }],
          status: 'ACTIVE',
          role: { notIn: ['MASTER'] },
        };
        const siteWorkItemFilter: Prisma.WorkItemWhereInput = {
          startedByWorker: { OR: [{ siteId: site.id }, { siteId: null }] },
        };

        const [
          workerCount,
          last30dWorkItems,
          previous30dWorkItems,
          recent7dTotalCount,
          recent7dEndedCount,
          activeCount,
          longRunningActiveCount,
          lastWorkItem,
          openCaseCount,
          p1OpenCaseCount,
          latestUsageSnapshot,
        ] = await Promise.all([
          this.prisma.worker.count({ where: siteWorkerFilter }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: last30Start },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: prev30Start, lt: last30Start },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: sevenDaysAgo },
              status: { not: 'VOID' },
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              startedAt: { gte: sevenDaysAgo },
              status: 'ENDED',
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              status: 'ACTIVE',
            },
          }),
          this.prisma.workItem.count({
            where: {
              ...siteWorkItemFilter,
              status: 'ACTIVE',
              startedAt: { lte: longRunningThreshold },
            },
          }),
          this.prisma.workItem.findFirst({
            where: siteWorkItemFilter,
            orderBy: { startedAt: 'desc' },
            select: { startedAt: true },
          }),
          this.prisma.supportCase.count({
            where: {
              siteId: site.id,
              status: { in: ['OPEN', 'IN_PROGRESS'] },
            },
          }),
          this.prisma.supportCase.count({
            where: {
              siteId: site.id,
              status: { in: ['OPEN', 'IN_PROGRESS'] },
              severity: 'P1',
            },
          }),
          this.prisma.usageSnapshot.findFirst({
            where: { siteId: site.id },
            orderBy: { month: 'desc' },
          }),
        ]);

        const subscription = site.subscriptions[0] || null;
        const subscriptionStatus = subscription?.status || 'NONE';

        // #29 온보딩 = 개통 준비도 필수 항목 충족 수 (자동감지)
        const readiness = readinessMap.get(site.id) ?? null;
        const requiredOk = readiness?.requiredOk ?? 0;
        const requiredTotal = readiness?.requiredTotal ?? 4;
        const onboardingStatus =
          requiredOk >= requiredTotal
            ? 'COMPLETED'
            : requiredOk > 0
              ? 'IN_PROGRESS'
              : 'NOT_STARTED';
        const onboardingProgressPercent = Math.round(
          (requiredOk / Math.max(requiredTotal, 1)) * 100,
        );
        const onboardingIncomplete = onboardingStatus !== 'COMPLETED';

        const daysSinceLastActivity = lastWorkItem?.startedAt
          ? Math.floor(
              (now.getTime() - lastWorkItem.startedAt.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : null;

        const healthReasons: string[] = [];
        let health: SiteHealth = 'HEALTHY';

        if (
          ['PAST_DUE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(subscriptionStatus)
        ) {
          health = 'AT_RISK';
          healthReasons.push(`구독 상태 ${subscriptionStatus}`);
        }
        if (p1OpenCaseCount > 0) {
          health = 'AT_RISK';
          healthReasons.push(`P1 지원 케이스 ${p1OpenCaseCount}건`);
        }
        if (longRunningActiveCount > 0) {
          health = 'AT_RISK';
          healthReasons.push(`장시간 진행중 ${longRunningActiveCount}건`);
        }
        if (
          health !== 'AT_RISK' &&
          (openCaseCount > 0 ||
            (daysSinceLastActivity !== null && daysSinceLastActivity >= 7) ||
            onboardingIncomplete)
        ) {
          health = 'NEEDS_ATTENTION';
        }
        if (openCaseCount > 0 && !healthReasons.includes(`지원 케이스 ${openCaseCount}건`)) {
          healthReasons.push(`지원 케이스 ${openCaseCount}건`);
        }
        if (daysSinceLastActivity !== null && daysSinceLastActivity >= 7) {
          healthReasons.push(`최근 활동 ${daysSinceLastActivity}일 전`);
        }
        if (onboardingIncomplete) {
          const missing = (readiness?.required ?? [])
            .filter((item) => !item.ok)
            .map((item) => item.label)
            .join('·');
          healthReasons.push(
            `개통 준비 ${requiredOk}/${requiredTotal}${missing ? ` (미충족: ${missing})` : ''}`,
          );
        }

        const workerUtilizationPercent =
          subscription?.plan?.maxWorkers && latestUsageSnapshot
            ? Number(
                (
                  (latestUsageSnapshot.workerCount / subscription.plan.maxWorkers) *
                  100
                ).toFixed(1),
              )
            : null;

        return {
          id: site.id,
          name: site.name,
          code: site.code,
          isActive: site.isActive,
          createdAt: site.createdAt,
          workerCount,
          workItemCount: last30dWorkItems,
          openCaseCount,
          p1OpenCaseCount,
          activeCount,
          longRunningActiveCount,
          lastActivity: lastWorkItem?.startedAt || null,
          daysSinceLastActivity,
          subscriptionStatus,
          subscriptionPlanName: subscription?.plan?.name || 'Free',
          health,
          healthReasons,
          // #29 준비도 기반 온보딩 (step = 필수 충족 수, totalSteps = 필수 항목 수)
          onboarding: {
            status: onboardingStatus,
            step: requiredOk,
            totalSteps: requiredTotal,
            progressPercent: onboardingProgressPercent,
            updatedAt: null as Date | null,
            required: readiness?.required ?? [],
            optional: readiness?.optional ?? [],
          },
          // #45 연락처·메모
          contact: this.contactFromSettings(settingsMap.get(site.id) ?? {}),
          // #42 기간 집계 (from/to)
          period: periodMap.get(site.id) ?? this.emptyPeriodAggregate(),
          usage: latestUsageSnapshot
            ? {
                month: latestUsageSnapshot.month,
                workerCount: latestUsageSnapshot.workerCount,
                workItemCount: latestUsageSnapshot.workItemCount,
                totalVolume: Number(latestUsageSnapshot.totalVolume),
                totalQuantity: latestUsageSnapshot.totalQuantity,
                workerUtilizationPercent,
              }
            : null,
          metrics: {
            last30dWorkItems,
            previous30dWorkItems,
            trendPercent: this.calculateTrend(
              last30dWorkItems,
              previous30dWorkItems,
            ),
            averageDailyWorkItems: Number((last30dWorkItems / 30).toFixed(1)),
            completionRate7d:
              recent7dTotalCount === 0
                ? 0
                : Number(
                    ((recent7dEndedCount / recent7dTotalCount) * 100).toFixed(1),
                  ),
          },
        };
      }),
    );

    // #42 NULL 작업자(미배정) 행 — 기간 내 활동이나 활성 작업자가 있을 때만 노출
    const unassignedAgg = periodMap.get(UNASSIGNED_KEY) ?? null;
    const unassigned =
      unassignedAgg &&
      (unassignedAgg.count > 0 ||
        unassignedAgg.stuckCount > 0 ||
        unassignedAgg.activeWorkerCount > 0)
        ? { id: UNASSIGNED_KEY, name: '미배정', period: unassignedAgg }
        : null;

    return { sites: rows, unassigned };
  }

  private async getRecentFailedLogins(siteId?: string) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.prisma.loginHistory.findMany({
      where: {
        success: false,
        createdAt: { gte: dayAgo },
        ...(siteId && { worker: { OR: [{ siteId }, { siteId: null }] } }),
      },
      include: {
        worker: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            site: { select: { id: true, name: true, code: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
  }

  /**
   * 계정 잠금 해제 (MASTER 보안 콘솔)
   * 잠금은 "최근 30분 내 실패 5건"으로 판정되므로, 해당 윈도우의 실패 로그인 이력을
   * 정리하면 즉시 해제된다. 성공 기록은 보존한다.
   */
  async unlockAccount(workerId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, name: true, employeeCode: true },
    });
    if (!worker) {
      throw new NotFoundException('작업자를 찾을 수 없습니다');
    }
    const cutoff = new Date(Date.now() - this.LOCKOUT_DURATION_MS);
    const result = await this.prisma.loginHistory.deleteMany({
      where: { workerId, success: false, createdAt: { gte: cutoff } },
    });
    return {
      workerId: worker.id,
      employeeCode: worker.employeeCode,
      name: worker.name,
      clearedAttempts: result.count,
      unlocked: true,
    };
  }

  private async getLockedWorkers(siteId?: string) {
    const lockoutCutoff = new Date(Date.now() - this.LOCKOUT_DURATION_MS);

    const workers = await this.prisma.worker.findMany({
      where: {
        status: 'ACTIVE',
        role: { notIn: ['MASTER'] },
        ...(siteId && { OR: [{ siteId }, { siteId: null }] }),
      },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        site: { select: { id: true, name: true, code: true } },
      },
    });

    if (workers.length === 0) {
      return [];
    }

    const recentHistory = await this.prisma.loginHistory.findMany({
      where: {
        workerId: { in: workers.map((worker) => worker.id) },
        createdAt: { gte: lockoutCutoff },
      },
      orderBy: { createdAt: 'desc' },
    });

    const historyByWorker = new Map<string, typeof recentHistory>();
    for (const item of recentHistory) {
      const bucket = historyByWorker.get(item.workerId) || [];
      bucket.push(item);
      historyByWorker.set(item.workerId, bucket);
    }

    return workers
      .filter((worker) => {
        const bucket = (historyByWorker.get(worker.id) || []).slice(
          0,
          this.MAX_FAILED_ATTEMPTS,
        );
        return (
          bucket.length >= this.MAX_FAILED_ATTEMPTS &&
          bucket.every((entry) => !entry.success)
        );
      })
      .map((worker) => ({
        workerId: worker.id,
        name: worker.name,
        employeeCode: worker.employeeCode,
        site: worker.site,
      }));
  }

  private calculateTrend(current: number, previous: number) {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return Number((((current - previous) / previous) * 100).toFixed(1));
  }

  private safeParseJson(input: string | null | undefined): Record<string, unknown> {
    if (!input) return {};
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private getSeverityRank(severity: 'critical' | 'warning' | 'info') {
    if (severity === 'critical') return 0;
    if (severity === 'warning') return 1;
    return 2;
  }
}
