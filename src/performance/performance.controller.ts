import {
  Controller,
  Get,
  Post,
  Patch,
  Query,
  Body,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PerformanceService } from './performance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { EntitlementGuard } from '../common/guards/entitlement.guard';
import { Feature } from '../common/decorators/feature.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';
import { CreateIncentivePolicyDto } from './dto/create-incentive-policy.dto';
import { UpdateIncentivePolicyDto } from './dto/update-incentive-policy.dto';

@Controller('admin/performance')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@Feature('PERFORMANCE')
@Roles('ADMIN', 'SUPERVISOR')
@ApiBearerAuth('jwt')
@ApiTags('Admin Performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Get('rankings')
  @ApiOperation({ summary: '작업자별 생산성 랭킹' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['score', 'count', 'volume', 'quantity', 'duration'] })
  getRankings(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('sortBy') sortBy: string | undefined,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.performanceService.getRankings(siteId, from, to, sortBy);
  }

  @Get('summary')
  @ApiOperation({ summary: '전체 요약 통계' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  getSummary(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    this.validateDateRange(from, to);
    const siteId = resolveSiteId(user, querySiteId);
    return this.performanceService.getSummary(siteId, from, to);
  }

  // ── 인센티브 정책 ──

  @Get('/incentive-policies')
  @ApiOperation({ summary: '인센티브 정책 조회' })
  @ApiQuery({ name: 'siteId', required: false, type: String })
  getIncentivePolicies(
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    if (!siteId) return []; // siteId 없으면 빈 배열 반환 (MASTER가 전체 조회 시)
    return this.performanceService.getIncentivePolicies(siteId);
  }

  @Post('/incentive-policies')
  @Roles('ADMIN')
  @ApiOperation({ summary: '인센티브 정책 생성' })
  createIncentivePolicy(
    @Body() dto: CreateIncentivePolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // MASTER가 아닌 경우 자기 사업장만
    if (user?.role !== 'MASTER' && user?.siteId) {
      dto.siteId = user.siteId;
    }
    return this.performanceService.createIncentivePolicy(dto);
  }

  @Patch('/incentive-policies/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: '인센티브 정책 수정' })
  updateIncentivePolicy(
    @Param('id') id: string,
    @Body() dto: UpdateIncentivePolicyDto,
  ) {
    return this.performanceService.updateIncentivePolicy(id, dto);
  }

  private validateDateRange(from: string, to: string) {
    if (!from || !to) throw new BadRequestException('from과 to 날짜가 모두 필요합니다');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()))
      throw new BadRequestException('올바른 날짜 형식이 아닙니다');
    if (fromDate > toDate)
      throw new BadRequestException('시작 날짜가 종료 날짜보다 늦을 수 없습니다');
  }
}
