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
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { WorkItemsService } from './work-items.service';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { EndWorkItemDto } from './dto/end-work-item.dto';
import { PauseWorkItemDto } from './dto/pause-work-item.dto';
import {
  UpdateWorkItemDto,
  VoidWorkItemDto,
  ForceEndWorkItemDto,
} from './dto/update-work-item.dto';
import { QueryWorkItemsDto } from './dto/query-work-items.dto';
import { CreateManualWorkItemDto } from './dto/create-manual-work-item.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';
import { SubscriptionGateGuard } from '../common/guards/subscription-gate.guard';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';

@Controller()
export class WorkItemsController {
  constructor(private readonly workItemsService: WorkItemsService) {}

  // ===================== Mobile Endpoints =====================

  @Post('mobile/work-items')
  @UseGuards(JwtAuthGuard, SubscriptionGateGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 시작 (모바일)',
    description: '새 작업을 시작합니다. 멱등성 키로 중복 생성 방지.',
  })
  @ApiResponse({ status: 201, description: '작업 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  createWorkItem(
    @Body() dto: CreateWorkItemDto,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    // ★ 호출자(태블릿/관리자 토큰)를 전달해 작업자/분류/참여자 siteId 격리 검증
    return this.workItemsService.create(dto, ip, userAgent, user);
  }

  @Get('mobile/work-items')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiQuery({ name: 'siteId', required: false, description: '사업장 ID로 격리' })
  @ApiOperation({
    summary: '작업 목록 (모바일, 사업장 격리)',
    description: '작업 목록을 조회합니다. siteId로 사업장 격리, status로 상태 필터.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: '상태 필터 (쉼표 구분 가능, 기본: ACTIVE). 예: ACTIVE,PAUSED',
  })
  @ApiQuery({
    name: 'workerId',
    required: false,
    description: '특정 작업자의 작업만 조회',
  })
  @ApiResponse({ status: 200, description: '작업 목록' })
  findActiveWorkItems(
    @CurrentUser() user: JwtPayload,
    @Query('workerId') workerId?: string,
    @Query('status') status?: string,
    @Query('siteId') querySiteId?: string,
    @Query('from') from?: string, // YYYY-MM-DD (KST 자정) 또는 full ISO
    @Query('to') to?: string,     // YYYY-MM-DD (KST 말일) 또는 full ISO
  ) {
    // ★ siteId 격리: resolveSiteId 사용 (다른 admin endpoint와 일관성)
    //   - MASTER: querySiteId 또는 본인 siteId
    //   - 비-MASTER: 본인 JWT siteId 강제
    const siteId = resolveSiteId(user, querySiteId);
    return this.workItemsService.findActiveForMobile(workerId, status, siteId, from, to);
  }

  @Post('mobile/work-items/:id/end')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 종료 (모바일)',
    description: '진행 중인 작업을 종료합니다. 물량/수량 확정, 참여자 추가 가능.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '작업 종료 완료' })
  @ApiResponse({ status: 400, description: '이미 종료된 작업' })
  @ApiResponse({ status: 404, description: '작업 없음' })
  endWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndWorkItemDto,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.endWorkItem(id, dto, ip, userAgent, user);
  }

  @Post('mobile/work-items/:id/pause')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 중간마감 (모바일)',
    description: '진행 중인 작업을 일시정지합니다. ACTIVE -> PAUSED.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '중간마감 완료' })
  @ApiResponse({ status: 400, description: '활성 상태가 아닌 작업' })
  @ApiResponse({ status: 404, description: '작업 없음' })
  pauseWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PauseWorkItemDto,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.pauseWorkItem(id, dto, ip, userAgent, user);
  }

  @Post('mobile/work-items/:id/resume')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 이어하기 (모바일)',
    description: '중간마감된 작업을 재개합니다. PAUSED -> ACTIVE.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiQuery({
    name: 'resumedByWorkerId',
    required: true,
    description: '이어하기 처리하는 작업자 ID',
  })
  @ApiResponse({ status: 200, description: '이어하기 완료' })
  @ApiResponse({ status: 400, description: '중간마감 상태가 아닌 작업' })
  @ApiResponse({ status: 404, description: '작업 없음' })
  resumeWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('resumedByWorkerId') resumedByWorkerId: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.resumeWorkItem(id, resumedByWorkerId, ip, userAgent, user);
  }

  @Post('mobile/work-items/:id/restore')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 복원 (모바일)',
    description: '종료된 작업을 ACTIVE로 되돌립니다. ENDED → ACTIVE.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '복원 완료' })
  @ApiResponse({ status: 400, description: '종료 상태가 아닌 작업' })
  @ApiResponse({ status: 404, description: '작업 없음' })
  restoreWorkItemMobile(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.restoreWorkItem(id, user, ip, userAgent);
  }

  @Post('admin/work-items/:id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({ summary: '작업 복원 (관리자) — ENDED → ACTIVE' })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '복원 완료' })
  restoreWorkItemAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.restoreWorkItem(id, user, ip, userAgent);
  }

  @Delete('mobile/work-items/:id')
  @UseGuards(JwtAuthGuard)
  @ApiTags('Mobile Work Items')
  @ApiOperation({ summary: '작업 무효화 (모바일)' })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  deleteWorkItemMobile(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.voidWorkItemFromMobile(id, ip, userAgent, user);
  }

  // ===================== Admin Endpoints =====================

  @Get('admin/work-items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 목록 조회 (관리자)',
    description: '페이지네이션, 상태/분류/작업자/날짜 범위 필터 지원.',
  })
  @ApiResponse({ status: 200, description: '작업 목록 + 페이지네이션 메타' })
  findAllForAdmin(
    @Query() query: QueryWorkItemsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // siteId 격리: ADMIN은 자기 사업장만, MASTER는 전체 또는 지정
    const siteId = resolveSiteId(user, query.siteId);
    return this.workItemsService.findAllForAdmin(query, siteId);
  }

  // ★ 고정 경로 — 'admin/work-items/:id' 계열보다 먼저 선언 (#35 수기 등록)
  @Post('admin/work-items')
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGateGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 기록 수기 등록 (관리자)',
    description:
      '이미 끝난 작업을 사후 등록합니다 (상태 ENDED). startedAt ≤ endedAt ≤ 현재 시각. ' +
      '작업자/분류/참여자는 호출자 사업장(MASTER는 시작 작업자 사업장) 소속만 허용. 사유 필수(2~200자), 감사 로그 MANUAL_CREATE.',
  })
  @ApiResponse({ status: 201, description: '수기 등록 완료 (작업 객체 반환)' })
  @ApiResponse({ status: 400, description: '시간 역전/미래 시각/유효하지 않은 작업자·분류' })
  @ApiResponse({ status: 403, description: '다른 사업장 자원 사용 또는 권한 없음' })
  createManualWorkItem(
    @Body() dto: CreateManualWorkItemDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.createManualForAdmin(dto, user, ip, userAgent);
  }

  // ★ 반드시 'admin/work-items/:id' 보다 먼저 선언 — 아니면 'export'가 :id(ParseUUIDPipe)에 걸려 400
  @Get('admin/work-items/export')
  @UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @Feature('CSV_EXPORT')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 기록 CSV 내보내기 (관리자)',
    description: '목록 조회와 동일한 상태/분류/작업자/날짜 범위 필터 적용. 최대 10,000건.',
  })
  @ApiResponse({ status: 200, description: 'CSV 파일 (BOM + UTF-8)' })
  @ApiResponse({ status: 403, description: '플랜에 CSV_EXPORT 기능 없음' })
  async exportCsvForAdmin(
    @Query() query: QueryWorkItemsDto,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    // siteId 격리: ADMIN은 자기 사업장만, MASTER는 전체 또는 지정
    const siteId = resolveSiteId(user, query.siteId);
    const csvContent = await this.workItemsService.exportCsvForAdmin(query, siteId);
    const filename = `work-items-${query.from || 'all'}-to-${query.to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  }

  @Get('admin/work-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 상세 조회 (관리자)',
    description: '배정 목록 + 감사 로그 포함.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '작업 상세 정보' })
  @ApiResponse({ status: 404, description: '작업 없음' })
  findOneForAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.workItemsService.findOneForAdmin(id, user);
  }

  @Patch('admin/work-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 수정 (관리자)',
    description: '수정 사유 필수. 감사 로그 자동 생성.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '작업 수정 완료' })
  @ApiResponse({ status: 400, description: '무효화된 작업 수정 불가' })
  updateWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkItemDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.updateForAdmin(id, dto, user.sub, ip, userAgent, user);
  }

  @Post('admin/work-items/:id/void')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 무효화 (관리자)',
    description: '무효화 사유 필수. 감사 로그 자동 생성.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '작업 무효화 완료' })
  voidWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidWorkItemDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.voidWorkItem(id, dto, user.sub, ip, userAgent, user);
  }

  @Post('admin/work-items/:id/force-end')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Work Items')
  @ApiOperation({
    summary: '작업 강제 종료 (반장/관리자)',
    description: '미종료 작업 강제 종료. 사유 필수.',
  })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  @ApiResponse({ status: 200, description: '강제 종료 완료' })
  @ApiResponse({ status: 400, description: '활성 상태가 아닌 작업' })
  forceEndWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForceEndWorkItemDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.forceEnd(id, dto, user.sub, ip, userAgent, user);
  }

  @Delete('admin/work-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('Admin Work Items')
  @ApiOperation({ summary: '작업 기록 삭제 (관리자)' })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  deleteWorkItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.workItemsService.deleteWorkItem(id, user);
  }
}
