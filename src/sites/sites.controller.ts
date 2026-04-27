import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { SitesService } from './sites.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller()
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/sites')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Sites')
  @ApiOperation({ summary: '사업장 목록 조회 — MASTER: 전체, ADMIN: 소속만' })
  @ApiResponse({ status: 200, description: '사업장 목록' })
  findAll(@CurrentUser() user: JwtPayload) {
    // MASTER는 전체, ADMIN은 소속 사업장만
    if (user.role === 'MASTER') {
      return this.sitesService.findAll();
    }
    return this.sitesService.findBySiteId(user.siteId);
  }

  @Post('admin/sites')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Sites')
  @ApiOperation({ summary: '사업장 생성 — MASTER: 어디든, ADMIN: 본인 하위만' })
  @ApiResponse({ status: 201, description: '사업장 생성 완료' })
  @ApiResponse({ status: 400, description: '유효성 검사 실패' })
  @ApiResponse({ status: 409, description: '코드 중복' })
  create(@Body() dto: CreateSiteDto, @CurrentUser() user: JwtPayload) {
    // ADMIN은 본인 사업장 하위에만 생성 가능
    if (user.role !== 'MASTER') {
      if (!dto.parentSiteId || dto.parentSiteId !== user.siteId) {
        throw new BadRequestException('본인 사업장 하위에만 서브 사업장을 생성할 수 있습니다');
      }
    }
    return this.sitesService.create(dto);
  }

  @Patch('admin/sites/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Sites')
  @ApiOperation({ summary: '사업장 수정 — ADMIN은 소속 사업장만 수정 가능' })
  @ApiParam({ name: 'id', description: '사업장 UUID' })
  @ApiResponse({ status: 200, description: '사업장 수정 완료' })
  @ApiResponse({ status: 404, description: '사업장 없음' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ADMIN은 소속 사업장만 수정 가능
    if (user.role !== 'MASTER' && user.siteId !== id) {
      throw new BadRequestException('소속 사업장만 수정할 수 있습니다');
    }
    return this.sitesService.update(id, dto);
  }

  @Post('admin/sites/:id/toggle-active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Sites')
  @ApiOperation({ summary: '사업장 활성/비활성 토글' })
  @ApiParam({ name: 'id', description: '사업장 UUID' })
  @ApiResponse({ status: 200, description: '토글 완료' })
  @ApiResponse({ status: 403, description: '다른 사업장 토글 불가' })
  toggleActive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ 소유권 검증: MASTER 외엔 자기 사업장만 토글
    if (user.role !== 'MASTER' && user.siteId !== id) {
      throw new ForbiddenException('소속 사업장만 토글할 수 있습니다');
    }
    return this.sitesService.toggleActive(id);
  }

  @Delete('admin/sites/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER')
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('Admin Sites')
  @ApiOperation({
    summary: '사업장 영구 삭제 (MASTER 전용)',
    description: '소속 작업자가 있으면 삭제 불가. DEFAULT 사업장 삭제 불가.',
  })
  @ApiParam({ name: 'id', description: '사업장 UUID' })
  @ApiResponse({ status: 204, description: '삭제(비활성화) 완료' })
  @ApiResponse({ status: 400, description: 'DEFAULT 사업장 삭제 불가' })
  @ApiResponse({ status: 404, description: '사업장 없음' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.sitesService.remove(id);
  }

  /**
   * 기존 작업자를 특정 사업장으로 일괄 이관
   * siteId가 없는(null) 또는 DEFAULT 사업장 소속 작업자를 대상 사업장으로 이동
   */
  @Post('admin/sites/:id/migrate-workers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Sites')
  @ApiOperation({ summary: '작업자 일괄 이관 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '대상 사업장 UUID' })
  @ApiResponse({ status: 200, description: '이관 완료 (이관 건수 반환)' })
  @ApiResponse({ status: 403, description: '다른 사업장으로 이관 불가' })
  migrateWorkers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ 소유권 검증: MASTER 외엔 자기 사업장으로만 이관 가능
    if (user.role !== 'MASTER' && user.siteId !== id) {
      throw new ForbiddenException('자기 사업장으로만 이관할 수 있습니다');
    }
    return this.sitesService.migrateWorkersToSite(id);
  }

  // ===================== Public Endpoints =====================

  @Get('sites/verify/:code')
  @ApiTags('Public Sites')
  @ApiOperation({
    summary: '사업장 코드 유효성 검증',
    description: '인증 불필요. 회원가입 폼에서 사업장 코드 확인용.',
  })
  @ApiParam({ name: 'code', description: '사업장 코드' })
  @ApiResponse({ status: 200, description: '{ valid: boolean, name: string }' })
  verifyCode(@Param('code') code: string) {
    return this.sitesService.verifyCode(code.toUpperCase());
  }
}
