import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMobileDiagnosticDto } from './dto/create-mobile-diagnostic.dto';

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 모바일 클라이언트 진단 로그 기록.
   * 인증된 사용자라면 누구나 자기 워커/사이트 컨텍스트로 진단을 보낼 수 있다.
   * production에서 console.log가 strip되어 디버깅 어려운 케이스 추적용.
   */
  async createMobileDiagnostic(
    dto: CreateMobileDiagnosticDto,
    workerId?: string,
    siteId?: string,
  ) {
    const record = await this.prisma.mobileDiagnostic.create({
      data: {
        workerId,
        siteId,
        screen: dto.screen,
        errorType: dto.errorType,
        errorMessage: dto.errorMessage,
        httpStatus: dto.httpStatus,
        hasToken: dto.hasToken ?? false,
        tokenAgeMinutes: dto.tokenAgeMinutes,
        networkOnline: dto.networkOnline,
        payloadSize: dto.payloadSize,
        appVersion: dto.appVersion,
        runtimeVersion: dto.runtimeVersion,
        platform: dto.platform,
        context: (dto.context as any) ?? undefined,
      },
    });

    // 로그도 남겨두면 Vercel logs에서 빠르게 검색 가능
    this.logger.warn(
      `[MobileDiagnostic] screen=${dto.screen} type=${dto.errorType} status=${dto.httpStatus ?? '-'} ` +
        `siteId=${siteId?.substring(0, 8) ?? '-'} worker=${workerId?.substring(0, 8) ?? '-'} ` +
        `online=${dto.networkOnline ?? '?'} tokenAge=${dto.tokenAgeMinutes ?? '?'}m payload=${dto.payloadSize ?? '-'}`,
    );

    return { id: record.id, recordedAt: record.createdAt };
  }

  /**
   * 최근 진단 로그 조회 (admin 용).
   * filter: errorType, screen, siteId, since(ISO date)
   */
  async list(params: {
    siteId?: string;
    errorType?: string;
    screen?: string;
    since?: Date;
    limit?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.siteId) where.siteId = params.siteId;
    if (params.errorType) where.errorType = params.errorType;
    if (params.screen) where.screen = params.screen;
    if (params.since) where.createdAt = { gte: params.since };

    return this.prisma.mobileDiagnostic.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(params.limit ?? 200, 1000),
    });
  }

  /**
   * 분기 1회 cron — 90일 이전 로그 자동 파기 (개인정보 보유 기간 정책과 일관).
   */
  async purgeOlderThanDays(days: number) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.prisma.mobileDiagnostic.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    this.logger.log(`[MobileDiagnostic] purged ${result.count} records older than ${days}d`);
    return result;
  }
}
