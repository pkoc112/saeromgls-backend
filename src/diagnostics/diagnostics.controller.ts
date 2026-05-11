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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { DiagnosticsService } from './diagnostics.service';
import { CreateMobileDiagnosticDto } from './dto/create-mobile-diagnostic.dto';

@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

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

  // ── 운영자가 조회: 최근 진단 로그 ───────────────────────────────────
  @Get('admin/diagnostics/mobile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Diagnostics')
  @ApiOperation({ summary: '모바일 진단 로그 최근 조회 (운영자 전용)' })
  async listMobile(
    @CurrentUser() user: JwtPayload,
    @Query('errorType') errorType?: string,
    @Query('screen') screen?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    const siteId = user.role === 'MASTER' ? undefined : user.siteId;
    return this.diagnosticsService.list({
      siteId,
      errorType,
      screen,
      since: since ? new Date(since) : undefined,
      limit: limit ? Number(limit) : 200,
    });
  }
}
