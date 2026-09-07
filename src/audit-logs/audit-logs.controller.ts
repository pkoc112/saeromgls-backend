import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuditLogsService, AUDIT_ACTIONS } from './audit-logs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Audit Logs')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @ApiOperation({
    summary: '감사 로그 조회 (작업 변경 이력)',
    description:
      '작업 항목 ID, 작업자 ID, 액션 타입, 기간(KST 일자)으로 필터 가능. siteId 격리 적용. ' +
      'FORCE_END 는 END + reason "[강제종료]" prefix 의 가상 액션.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1~200 (기본 50)' })
  @ApiQuery({ name: 'workItemId', required: false, type: String, description: '작업 항목 UUID 필터' })
  @ApiQuery({ name: 'actorWorkerId', required: false, type: String, description: '수행자 UUID 필터' })
  @ApiQuery({ name: 'action', required: false, enum: AUDIT_ACTIONS, description: '액션 타입 필터' })
  @ApiQuery({ name: 'from', required: false, type: String, description: '시작일 YYYY-MM-DD (KST, createdAt 기준)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: '종료일 YYYY-MM-DD (KST, createdAt 기준)' })
  @ApiQuery({ name: 'siteId', required: false, type: String, description: '사업장 UUID (MASTER만 지정 가능)' })
  @ApiResponse({ status: 200, description: '감사 로그 목록 + 페이지네이션 { data, meta }' })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('workItemId') workItemId?: string,
    @Query('actorWorkerId') actorWorkerId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('siteId') querySiteId?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.auditLogsService.findAll({
      page,
      limit,
      workItemId,
      actorWorkerId,
      action,
      from,
      to,
      siteId,
    });
  }
}
