import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ActivityLogsService } from './activity-logs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller('admin/activity-logs')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@Feature('ACTIVITY_LOGS')
@Roles('ADMIN')
@ApiBearerAuth('jwt')
@ApiTags('Admin Activity Logs')
export class ActivityLogsController {
  constructor(private readonly activityLogsService: ActivityLogsService) {}

  @Get()
  @ApiOperation({ summary: '관리자 활동 로그 조회' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'actionType', required: false, type: String })
  @ApiQuery({ name: 'actorWorkerId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getActivityLogs(
    @Query('siteId') querySiteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actionType') actionType?: string,
    @Query('actorWorkerId') actorWorkerId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    // 날짜 유효성 검사
    if (from && isNaN(new Date(from).getTime())) {
      throw new BadRequestException('올바른 from 날짜 형식이 아닙니다');
    }
    if (to && isNaN(new Date(to).getTime())) {
      throw new BadRequestException('올바른 to 날짜 형식이 아닙니다');
    }

    const siteId = resolveSiteId(user, querySiteId);

    return this.activityLogsService.getActivityLogs(siteId, {
      from,
      to,
      actionType,
      actorWorkerId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
