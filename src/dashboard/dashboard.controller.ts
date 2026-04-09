import { Controller, Get, Query, Res, UseGuards, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'KPI 통계 조회',
    description: '기간별 작업 건수, 물량, 평균 작업 시간, 분류별/작업자별 통계.',
  })
  @ApiQuery({ name: 'from', required: true, type: String, description: '시작 날짜 (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, type: String, description: '종료 날짜 (YYYY-MM-DD)' })
  @ApiResponse({ status: 200, description: 'KPI 통계 데이터' })
  getStats(@Query('from') from: string, @Query('to') to: string) {
    this.validateDateRange(from, to);
    return this.dashboardService.getStats(from, to);
  }

  @Get('trends')
  @ApiOperation({
    summary: '트렌드 데이터 (차트용)',
    description: '일별/주별/월별 작업 건수 및 물량 추이.',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({
    name: 'groupBy',
    required: false,
    enum: ['day', 'week', 'month'],
    description: '그룹핑 단위 (기본: day)',
  })
  @ApiResponse({ status: 200, description: '트렌드 데이터 배열' })
  getTrends(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('groupBy') groupBy?: 'day' | 'week' | 'month',
  ) {
    this.validateDateRange(from, to);
    return this.dashboardService.getTrends(from, to, groupBy);
  }

  @Get('export')
  @ApiOperation({
    summary: 'CSV 내보내기',
    description: '지정 기간의 작업 데이터를 CSV 파일로 다운로드.',
  })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['csv'],
    description: '내보내기 형식 (현재 csv만 지원)',
  })
  @ApiResponse({ status: 200, description: 'CSV 파일 다운로드' })
  async exportData(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    this.validateDateRange(from, to);

    const csvContent = await this.dashboardService.exportCsv(from, to);

    const filename = `work-items-${from}-to-${to}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  }

  /**
   * 날짜 범위 유효성 검사
   */
  private validateDateRange(from: string, to: string) {
    if (!from || !to) {
      throw new BadRequestException('from과 to 날짜가 모두 필요합니다');
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('올바른 날짜 형식이 아닙니다 (YYYY-MM-DD)');
    }

    if (fromDate > toDate) {
      throw new BadRequestException('시작 날짜가 종료 날짜보다 늦을 수 없습니다');
    }
  }
}
