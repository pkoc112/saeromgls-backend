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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Request } from 'express';
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller()
export class WorkItemsController {
  constructor(private readonly workItemsService: WorkItemsService) {}

  // ===================== Mobile Endpoints =====================

  @Post('mobile/work-items')
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 시작 (모바일)',
    description: '새 작업을 시작합니다. 멱등성 키로 중복 생성 방지.',
  })
  @ApiResponse({ status: 201, description: '작업 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  createWorkItem(@Body() dto: CreateWorkItemDto, @Req() req: Request) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.create(dto, ip, userAgent);
  }

  @Get('mobile/work-items')
  @ApiTags('Mobile Work Items')
  @ApiOperation({
    summary: '작업 목록 (모바일)',
    description: '작업 목록을 조회합니다. status 파라미터로 쉼표 구분 다중 상태 필터 가능 (예: ACTIVE,PAUSED).',
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
    @Query('workerId') workerId?: string,
    @Query('status') status?: string,
  ) {
    return this.workItemsService.findActiveForMobile(workerId, status);
  }

  @Post('mobile/work-items/:id/end')
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
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.endWorkItem(id, dto, ip, userAgent);
  }

  @Post('mobile/work-items/:id/pause')
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
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.pauseWorkItem(id, dto, ip, userAgent);
  }

  @Post('mobile/work-items/:id/resume')
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
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.resumeWorkItem(id, resumedByWorkerId, ip, userAgent);
  }

  @Delete('mobile/work-items/:id')
  @ApiTags('Mobile Work Items')
  @ApiOperation({ summary: '작업 무효화 (모바일)' })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  deleteWorkItemMobile(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.workItemsService.voidWorkItem(id, { reason: '모바일 삭제 요청' }, undefined, ip, userAgent);
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
  findAllForAdmin(@Query() query: QueryWorkItemsDto) {
    return this.workItemsService.findAllForAdmin(query);
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
  findOneForAdmin(@Param('id', ParseUUIDPipe) id: string) {
    return this.workItemsService.findOneForAdmin(id);
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
    return this.workItemsService.updateForAdmin(id, dto, user.sub, ip, userAgent);
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
    return this.workItemsService.voidWorkItem(id, dto, user.sub, ip, userAgent);
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
    return this.workItemsService.forceEnd(id, dto, user.sub, ip, userAgent);
  }

  @Delete('admin/work-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('Admin Work Items')
  @ApiOperation({ summary: '작업 기록 삭제 (관리자)' })
  @ApiParam({ name: 'id', description: '작업 UUID' })
  deleteWorkItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.workItemsService.deleteWorkItem(id);
  }
}
