import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';
import { PrismaService } from '../prisma/prisma.service';
import { DiagnosticsService } from './diagnostics.service';
import { CreateMobileDiagnosticDto } from './dto/create-mobile-diagnostic.dto';
import { MOBILE_DIAGNOSTIC_ERROR_TYPES } from './mobile-diagnostic.constants';
import { listMobileDiagnosticsPaginated } from './mobile-diagnostics.query';

@Controller()
export class DiagnosticsController {
  constructor(
    private readonly diagnosticsService: DiagnosticsService,
    private readonly prisma: PrismaService,
  ) {}

  // ── 모바일이 직접 호출: 진단 로그 기록 ─────────────────────────────
  // 인증된 사용자라면 누구나 호출 가능 (자기 워커/사이트로 자동 태깅).
  // 클라이언트 폭주 방어를 위해 분당 60회 rate limit.
  @Post('mobile/diagnostics')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiTags('Mobile Diagnostics')
  @ApiOperation({ summary: '모바일 진단 로그 기록 (production 디버깅용)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async createMobile(
    @Body() dto: CreateMobileDiagnosticDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.diagnosticsService.createMobileDiagnostic(
      dto,
      user?.sub,
      user?.siteId,
    );
    // 204 No Content — 진단 실패가 사용자 흐름을 방해하면 안 됨
  }

  // ── 익명 진단 endpoint ─────────────────────────────────────────────
  // 2026-05-14 (Codex 협업): refresh token 만료로 모든 인증 fetch가 실패하는
  // 케이스에서 진단 자체가 캐치 안 되는 blind spot 해소.
  // 인증 없이도 device 식별자만으로 진단을 받아 root cause 추적 가능.
  // 폭주 방어를 위해 IP당 분당 30회 더 엄격한 throttle.
  @Post('mobile/diagnostics-anonymous')
  @ApiTags('Mobile Diagnostics')
  @ApiOperation({ summary: '익명 모바일 진단 로그 (auth 만료 케이스 추적용)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async createMobileAnonymous(@Body() dto: CreateMobileDiagnosticDto) {
    // workerId, siteId 없이 기록 — context 안에 device 식별자가 들어있다면 그것만으로 추적
    await this.diagnosticsService.createMobileDiagnostic(dto);
  }

  // ── 운영자가 조회: 태블릿 진단 로그 (웹 '태블릿 진단' 탭) ──────────────
  // - siteId: resolveSiteId (MASTER 전체(+익명 NULL 포함) / ADMIN 자기 사업장 강제)
  // - 응답: { data, meta } 페이지네이션 규약
  // - since(ISO) 는 하위호환, from/to(KST 일자) 우선
  @Get('admin/diagnostics/mobile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Diagnostics')
  @ApiOperation({ summary: '태블릿(모바일) 진단 로그 목록 조회 (운영자 전용, 페이지네이션)' })
  @ApiQuery({ name: 'siteId', required: false, type: String, description: '사업장 UUID (MASTER만 지정 가능)' })
  @ApiQuery({ name: 'errorType', required: false, enum: MOBILE_DIAGNOSTIC_ERROR_TYPES })
  @ApiQuery({ name: 'screen', required: false, type: String, description: '화면명 부분 일치' })
  @ApiQuery({ name: 'from', required: false, type: String, description: '시작일 YYYY-MM-DD (KST)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: '종료일 YYYY-MM-DD (KST)' })
  @ApiQuery({ name: 'since', required: false, type: String, description: 'ISO datetime (하위호환, from 없을 때만)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1~200 (기본 50)' })
  @ApiResponse({ status: 200, description: '{ data: MobileDiagnostic[] (+workerName/siteName), meta }' })
  async listMobile(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
    @Query('errorType') errorType?: string,
    @Query('screen') screen?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('since') since?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return listMobileDiagnosticsPaginated(this.prisma, {
      siteId,
      errorType,
      screen,
      from,
      to,
      since,
      page,
      limit,
    });
  }
}
