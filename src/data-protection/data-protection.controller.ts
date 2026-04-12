import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DataProtectionService } from './data-protection.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@Feature('DATA_PROTECTION')
@Roles('ADMIN')
@ApiBearerAuth('jwt')
@ApiTags('Admin Data Protection')
export class DataProtectionController {
  constructor(private readonly dataProtectionService: DataProtectionService) {}

  // ── 백업 ──

  @Get('backups/status')
  @ApiOperation({ summary: '백업 상태 조회' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getBackupStatus(
    @Query('siteId') querySiteId?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.dataProtectionService.getBackupStatus(siteId);
  }

  @Post('backups/request')
  @ApiOperation({ summary: '백업 요청' })
  requestBackup(
    @Body() body: { siteId?: string; type?: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, body.siteId);
    return this.dataProtectionService.requestBackup(siteId, body.type || 'manual');
  }

  // ── 복원 요청 ──

  @Get('restore-requests')
  @ApiOperation({ summary: '복원 요청 목록 조회' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRestoreRequests(
    @Query('siteId') querySiteId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.dataProtectionService.getRestoreRequests(siteId, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('restore-requests')
  @ApiOperation({ summary: '복원 요청 생성' })
  createRestoreRequest(
    @Body() body: { siteId?: string; reason: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    if (!body.reason) {
      throw new BadRequestException('복원 사유(reason)가 필요합니다');
    }

    const siteId = resolveSiteId(user, body.siteId);
    if (!siteId) {
      throw new BadRequestException('siteId가 필요합니다');
    }

    if (!user?.sub) {
      throw new BadRequestException('인증 정보가 올바르지 않습니다');
    }

    return this.dataProtectionService.createRestoreRequest({
      siteId,
      requestedByWorkerId: user.sub,
      reason: body.reason,
    });
  }
}
