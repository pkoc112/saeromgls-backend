import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  @ApiOperation({ summary: '보고서 데이터 생성 (일간/주간/월간)' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'type', required: false, enum: ['daily', 'weekly', 'monthly'] })
  @ApiQuery({ name: 'includeAi', required: false, type: Boolean })
  getSummary(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('type') type: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('includeAi') includeAi?: string,
    @Query('siteId') querySiteId?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    if (!from || !to) {
      throw new BadRequestException('from과 to 날짜가 모두 필요합니다');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('올바른 날짜 형식이 아닙니다');
    }
    if (fromDate > toDate) {
      throw new BadRequestException('시작 날짜가 종료 날짜보다 늦을 수 없습니다');
    }

    // MASTER는 querySiteId 사용, 나머지는 JWT siteId 강제
    const siteId = user?.role === 'MASTER' ? (querySiteId || undefined) : user?.siteId;

    const aiFlag = includeAi === 'true' || includeAi === '1';

    return this.reportsService.generateSummary(siteId, from, to, type, aiFlag);
  }
}
