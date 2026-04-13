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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { WorkersService } from './workers.service';
import { CreateWorkerDto } from './dto/create-worker.dto';
import { UpdateWorkerDto } from './dto/update-worker.dto';
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
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '페이지당 항목 수 (기본: 20)' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE'], description: '상태 필터' })
  @ApiQuery({ name: 'siteId', required: false, description: '사업장 ID (MASTER만 지정 가능)' })
  @ApiResponse({ status: 200, description: '작업자 목록 + 페이지네이션 메타' })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('siteId') querySiteId?: string,
  ) {
    // MASTER: querySiteId 지정 가능 (없으면 전체), ADMIN/SUPERVISOR: 자기 사업장만
    const siteId = resolveSiteId(user, querySiteId);
    return this.workersService.findAll({ page, limit, status, siteId });
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
    if (user.role !== 'MASTER') {
      const target = await this.workersService.findOne(id);
      if (target.siteId && target.siteId !== user.siteId) {
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
    if (user.role !== 'MASTER') {
      const target = await this.workersService.findOne(id);
      if (target.siteId && target.siteId !== user.siteId) {
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
    description: '인증 불필요. PIN 로그인 화면에서 작업자 선택용.',
  })
  @ApiQuery({ name: 'siteId', required: false, description: '사업장 ID로 필터' })
  @ApiResponse({ status: 200, description: '활성 작업자 목록 (최소 필드)' })
  findActiveForMobile(@Query('siteId') siteId?: string) {
    return this.workersService.findActiveForMobile(siteId);
  }
}
