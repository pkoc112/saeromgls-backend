import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';

/**
 * 태블릿 진단 로그 목록 조회 (관리자 웹 '태블릿 진단' 탭)
 * - {data, meta} 페이지네이션 규약으로 통일
 * - siteId 격리는 호출부(resolveSiteId)에서 결정된 값을 그대로 적용
 *   (MASTER: undefined → 전체 + 익명(siteId NULL) 포함 / ADMIN: 자기 siteId 만)
 * - 작업자/센터 이름은 관계가 없으므로 배치 조회로 보강 (workerName, siteName)
 *
 * DiagnosticsService 는 배정 외 파일이라 컨트롤러가 이 헬퍼를 직접 사용한다.
 * (추후 DiagnosticsService.listPaginated 로 이관 가능)
 */

export const MOBILE_DIAGNOSTIC_ERROR_TYPES = [
  'network',
  'auth',
  'http_5xx',
  'empty_response',
  'timeout',
  'sync_dropped',
  'unknown',
] as const;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListMobileDiagnosticsParams {
  siteId?: string;
  errorType?: string;
  screen?: string;
  /** ISO datetime (하위호환) — createdAt >= since */
  since?: string;
  /** KST 일자 YYYY-MM-DD */
  from?: string;
  /** KST 일자 YYYY-MM-DD */
  to?: string;
  page?: number | string;
  limit?: number | string;
}

export async function listMobileDiagnosticsPaginated(
  prisma: PrismaService,
  params: ListMobileDiagnosticsParams,
) {
  // 쿼리 문자열이 그대로 올 수 있으므로 Number() 파싱 후 정수 보정 (limit 1~200 클램프)
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);
  const limit = Math.min(Math.max(1, Math.floor(Number(params.limit)) || 50), 200);
  const skip = (page - 1) * limit;

  const where: Prisma.MobileDiagnosticWhereInput = {};
  if (params.siteId) where.siteId = params.siteId;
  if (params.errorType?.trim()) where.errorType = params.errorType.trim();
  if (params.screen?.trim()) {
    where.screen = { contains: params.screen.trim(), mode: 'insensitive' };
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (params.from) {
    if (!DATE_ONLY_RE.test(params.from)) {
      throw new BadRequestException('from 은 YYYY-MM-DD 형식이어야 합니다');
    }
    createdAt.gte = kstStartOfDay(params.from);
  } else if (params.since) {
    const sinceDate = new Date(params.since);
    if (isNaN(sinceDate.getTime())) {
      throw new BadRequestException('since 는 ISO 날짜 형식이어야 합니다');
    }
    createdAt.gte = sinceDate;
  }
  if (params.to) {
    if (!DATE_ONLY_RE.test(params.to)) {
      throw new BadRequestException('to 는 YYYY-MM-DD 형식이어야 합니다');
    }
    createdAt.lte = kstEndOfDay(params.to);
  }
  if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
    throw new BadRequestException('시작일이 종료일보다 늦을 수 없습니다');
  }
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  const [rows, total] = await Promise.all([
    prisma.mobileDiagnostic.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.mobileDiagnostic.count({ where }),
  ]);

  // 작업자/센터 이름 보강 (관계 없음 → 배치 조회)
  const workerIds = Array.from(
    new Set(rows.map((r) => r.workerId).filter((v): v is string => !!v)),
  );
  const siteIds = Array.from(
    new Set(rows.map((r) => r.siteId).filter((v): v is string => !!v)),
  );

  const [workers, sites] = await Promise.all([
    workerIds.length
      ? prisma.worker.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : Promise.resolve([] as { id: string; name: string; employeeCode: string }[]),
    siteIds.length
      ? prisma.site.findMany({
          where: { id: { in: siteIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  const workerMap = new Map(workers.map((w) => [w.id, w]));
  const siteMap = new Map(sites.map((s) => [s.id, s]));

  const data = rows.map((r) => {
    const worker = r.workerId ? workerMap.get(r.workerId) : undefined;
    const site = r.siteId ? siteMap.get(r.siteId) : undefined;
    return {
      ...r,
      // 익명 진단(auth 만료 등)은 workerId/siteId 가 없음 → 웹에서 '미식별' 표기
      workerName: worker?.name ?? null,
      workerEmployeeCode: worker?.employeeCode ?? null,
      siteName: site?.name ?? null,
    };
  });

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
