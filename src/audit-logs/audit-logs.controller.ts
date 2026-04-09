import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuditLogsService } from './audit-logs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Audit Logs')
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @ApiOperation({
    summary: '감사 로그 조회',
    description: '작업 항목 ID, 작업자 ID, 액션 타입으로 필터 가능.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'workItemId', required: false, type: String, description: '작업 항목 UUID 필터' })
  @ApiQuery({ name: 'actorWorkerId', required: false, type: String, description: '수행자 UUID 필터' })
  @ApiQuery({ name: 'action', required: false, enum: ['CREATE', 'END', 'EDIT', 'VOID'], description: '액션 타입 필터' })
  @ApiResponse({ status: 200, description: '감사 로그 목록 + 페이지네이션' })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('workItemId') workItemId?: string,
    @Query('actorWorkerId') actorWorkerId?: string,
    @Query('action') action?: string,
  ) {
    return this.auditLogsService.findAll({
      page,
      limit,
      workItemId,
      actorWorkerId,
      action,
    });
  }
}
