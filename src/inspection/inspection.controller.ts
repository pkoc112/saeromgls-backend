import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { InspectionService } from './inspection.service';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { QueryInspectionDto } from './dto/query-inspection.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Admin Inspections')
@ApiBearerAuth('jwt')
@Controller('admin/inspections')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InspectionController {
  constructor(private readonly inspectionService: InspectionService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '검수 기록 목록 조회',
    description: '검수 기록을 페이지네이션으로 조회합니다. 결과/날짜 필터 지원.',
  })
  @ApiResponse({ status: 200, description: '검수 기록 목록 + 페이지네이션 메타' })
  findAll(
    @Query() query: QueryInspectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.inspectionService.findAll(siteId, query);
  }

  @Get('pending')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({ summary: '검수 대기 목록 (당일 ENDED 중 미검수)' })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD (기본: 오늘)' })
  @ApiQuery({ name: 'siteId', required: false })
  getPending(
    @Query('date') date: string | undefined,
    @Query('siteId') querySiteId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.inspectionService.getPendingItems(siteId, date);
  }

  @Post('batch')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({ summary: '일괄 검수 (전량 PASS + 이슈 개별 마킹)' })
  batchInspect(
    @Body() dto: { inspectedByWorkerId: string; date: string; issues?: { workItemId: string; issueType: string; notes?: string }[] },
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined) || user.siteId || '';
    return this.inspectionService.batchInspect(siteId, dto);
  }

  @Post()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '검수 기록 개별 생성',
    description: '종료된 작업에 대해 검수 기록을 생성합니다.',
  })
  @ApiResponse({ status: 201, description: '검수 기록 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  @ApiResponse({ status: 404, description: '대상 작업 없음' })
  create(
    @Body() dto: CreateInspectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, undefined);
    // ★ ADMIN/SUPERVISOR는 반드시 siteId가 있어야 함 (없으면 거부, 빈 문자열로 DB 오염 방지)
    // MASTER는 siteId가 undefined일 수 있는데, 그 경우 서비스에서 대상 작업의 siteId 사용
    if (user.role !== 'MASTER' && !siteId) {
      throw new BadRequestException('사업장이 배정되지 않은 사용자는 검수 기록을 생성할 수 없습니다');
    }
    return this.inspectionService.create(dto, siteId, user.sub);
  }

  @Get('stats')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '검수 통계 요약',
    description: '검수 커버리지, 정확도, 결과별 건수를 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '검수 통계 데이터' })
  getStats(
    @Query('siteId') querySiteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.inspectionService.getStats(siteId, from, to);
  }
}
