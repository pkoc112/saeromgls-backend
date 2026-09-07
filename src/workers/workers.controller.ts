import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WorkersService } from './workers.service';
import { CreateWorkerDto } from './dto/create-worker.dto';
import { UpdateWorkerDto } from './dto/update-worker.dto';
import { BulkCreateWorkersDto, BULK_WORKERS_MAX_ROWS } from './dto/bulk-create-workers.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller()
export class WorkersController {
  constructor(private readonly workersService: WorkersService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/workers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 목록 조회 (관리자 — 사업장 격리)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '페이지 번호 (기본: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '페이지당 항목 수 (기본: 20, 최대: 200)' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE'], description: '상태 필터' })
  @ApiQuery({ name: 'siteId', required: false, description: '사업장 ID (MASTER만 지정 가능)' })
  @ApiQuery({ name: 'search', required: false, type: String, description: '이름 또는 사번 검색 (부분 일치, 대소문자 무시)' })
  @ApiResponse({ status: 200, description: '작업자 목록 + 페이지네이션 메타' })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('siteId') querySiteId?: string,
    @Query('role') role?: string,
    @Query('search') search?: string,
  ) {
    // MASTER: querySiteId 지정 가능 (없으면 전체), ADMIN/SUPERVISOR: 자기 사업장만
    const siteId = resolveSiteId(user, querySiteId);
    // role 필터는 service에서 호출자 역할로 권한 게이트 (관리자 조회는 MASTER/ADMIN만)
    return this.workersService.findAll({ page, limit, status, siteId, role, search, callerRole: user.role });
  }

  @Post('admin/workers/migrate-tracks-v3')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 jobTrack 구 5트랙 → 신 4트랙 마이그레이션' })
  @ApiResponse({ status: 200, description: '마이그레이션 완료' })
  async migrateJobTracksV3(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.workersService.migrateJobTracksV3(siteId);
  }

  // ★ 고정 경로('bulk')는 'admin/workers/:id' 계열보다 먼저 선언 (라우트 매칭 순서)
  @Post('admin/workers/bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({
    summary: `작업자 일괄 등록 (최대 ${BULK_WORKERS_MAX_ROWS}행, 행별 성공/실패 반환)`,
    description:
      'body { rows: [{ name, employeeCode, role?, pin? }], siteId? }. ' +
      'WORKER 행은 pin 생략 시 난수 4자리를 생성해 created[].pin에 평문 1회 반환. ' +
      'SUPERVISOR/ADMIN 행은 pin 필수, ADMIN 행은 MASTER 호출자만 가능. ' +
      'ADMIN 호출자는 자기 사업장 강제(siteId 무시/불일치 시 403), MASTER는 siteId 지정.',
  })
  @ApiResponse({
    status: 201,
    description: '{ total, created: [{ row, id, employeeCode, name, role, pin? }], failed: [{ row, employeeCode, name, reason }] }',
  })
  @ApiResponse({ status: 400, description: 'DTO 검증 실패 (행 수 초과, 필드 형식 오류)' })
  @ApiResponse({ status: 403, description: '다른 사업장 siteId 지정 (ADMIN)' })
  bulkCreate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkCreateWorkersDto,
  ) {
    // ADMIN이 다른 사업장 siteId를 직접 지정하려 하면 차단 (create와 동일 정책)
    if (user.role !== 'MASTER' && dto.siteId && dto.siteId !== user.siteId) {
      throw new ForbiddenException('자신의 사업장에만 작업자를 추가할 수 있습니다');
    }
    // MASTER: body.siteId(없으면 미배정), ADMIN: JWT siteId 강제 (미배정 계정은 403)
    const siteId = resolveSiteId(user, dto.siteId);
    return this.workersService.bulkCreate(dto.rows, siteId, user.role);
  }

  @Post('admin/workers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 생성 (ADMIN: 자기 사업장 자동 배정, MASTER: siteId 지정)' })
  @ApiResponse({ status: 201, description: '작업자 생성 완료' })
  @ApiResponse({ status: 409, description: '사번 중복' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateWorkerDto,
  ) {
    // ADMIN이 다른 사업장 siteId를 직접 지정하려 하면 차단
    if (user.role !== 'MASTER' && dto.siteId && dto.siteId !== user.siteId) {
      throw new ForbiddenException('자신의 사업장에만 작업자를 추가할 수 있습니다');
    }
    // ADMIN은 자기 사업장 자동 배정
    const callerSiteId = user.role === 'MASTER' ? undefined : user.siteId;
    return this.workersService.create(dto, callerSiteId);
  }

  @Patch('admin/workers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 정보 수정 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '작업자 UUID' })
  @ApiResponse({ status: 200, description: '작업자 수정 완료' })
  @ApiResponse({ status: 404, description: '작업자 없음' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkerDto,
  ) {
    // ADMIN이 사업장 변경을 시도하면 차단 (MASTER만 가능)
    if (user.role !== 'MASTER' && dto.siteId && dto.siteId !== user.siteId) {
      throw new ForbiddenException('사업장 변경은 마스터 관리자만 가능합니다');
    }
    // 대상 작업자가 자기 사업장 소속인지 확인
    // ★ siteId=NULL(레거시 미배정) 작업자는 비-MASTER가 손대지 못하도록 차단
    //   (`target.siteId &&` 단락 제거 — NULL 통과 시 계정탈취/PII변경 가능)
    if (user.role !== 'MASTER') {
      const target = await this.workersService.findOne(id);
      if (target.siteId !== user.siteId) {
        throw new ForbiddenException('다른 사업장의 작업자를 수정할 수 없습니다');
      }
    }
    return this.workersService.update(id, dto);
  }

  @Delete('admin/workers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 영구 삭제 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '작업자 UUID' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // 대상 작업자가 자기 사업장 소속인지 확인
    // ★ siteId=NULL(레거시 미배정) 작업자는 비-MASTER가 삭제하지 못하도록 차단
    if (user.role !== 'MASTER') {
      const target = await this.workersService.findOne(id);
      if (target.siteId !== user.siteId) {
        throw new ForbiddenException('다른 사업장의 작업자를 삭제할 수 없습니다');
      }
    }
    return this.workersService.delete(id);
  }

  // ===================== Mobile Endpoints =====================

  @Get('mobile/workers')
  @ApiTags('Mobile Workers')
  @ApiOperation({
    summary: '활성 작업자 목록 (모바일)',
    description:
      'PIN 로그인 화면에서 작업자 선택용. 인증은 없지만 siteId 필수(UUID) + Throttle로 brute-force 방어.',
  })
  @ApiQuery({ name: 'siteId', required: true, description: '사업장 UUID (필수)' })
  @ApiResponse({ status: 200, description: '활성 작업자 목록 (최소 필드)' })
  @ApiResponse({ status: 400, description: 'siteId 필수 또는 형식 오류' })
  // ★ siteId 강제 + UUID 형식 검증 + 분당 30회 제한 (PIN 로그인 정상 흐름엔 충분)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  findActiveForMobile(@Query('siteId') siteId?: string) {
    // 누락 시 거부 (이전엔 누락 시 전체 사업장 조회되어 cross-tenant leak)
    if (!siteId) {
      throw new BadRequestException('siteId는 필수입니다');
    }
    // UUID 형식 검증 — brute-force 방어
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(siteId)) {
      throw new BadRequestException('siteId는 UUID 형식이어야 합니다');
    }
    return this.workersService.findActiveForMobile(siteId);
  }
}
