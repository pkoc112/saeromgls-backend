import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { DockService } from './dock.service';
import { CreateDockSessionDto } from './dto/create-dock-session.dto';
import { EndDockSessionDto } from './dto/end-dock-session.dto';
import { QueryDockDto } from './dto/query-dock.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Admin Dock Sessions')
@ApiBearerAuth('jwt')
@Controller('admin/dock-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DockController {
  constructor(private readonly dockService: DockService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '도크 세션 목록 조회',
    description: '도크 세션을 페이지네이션으로 조회합니다. 상태/유형/날짜 필터 지원.',
  })
  @ApiResponse({ status: 200, description: '도크 세션 목록 + 페이지네이션 메타' })
  findAll(
    @Query() query: QueryDockDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.dockService.findAll(siteId, query);
  }

  @Post()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '도크 세션 시작',
    description: '새 상하차/랩핑 세션을 시작합니다.',
  })
  @ApiResponse({ status: 201, description: '도크 세션 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  create(
    @Body() dto: CreateDockSessionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // ★ siteId가 없으면 명시적 거부 (이전엔 빈 문자열 → DB 오염 위험)
    const siteId = resolveSiteId(user, undefined);
    if (!siteId) {
      throw new BadRequestException('사업장이 배정되지 않은 사용자는 도크 세션을 생성할 수 없습니다');
    }
    return this.dockService.create(dto, siteId, user.sub);
  }

  @Post(':id/end')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '도크 세션 종료',
    description: '진행 중인 세션을 종료합니다. 수량/랩핑 정보 확정.',
  })
  @ApiParam({ name: 'id', description: '도크 세션 UUID' })
  @ApiResponse({ status: 200, description: '세션 종료 완료' })
  @ApiResponse({ status: 400, description: '활성 상태가 아닌 세션' })
  @ApiResponse({ status: 404, description: '세션 없음' })
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndDockSessionDto,
  ) {
    return this.dockService.end(id, dto);
  }

  @Get('stats')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '도크 통계 요약',
    description: '도크 세션 수, 상하차 비율, 평균 소요시간 등을 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '도크 통계 데이터' })
  getStats(
    @Query('siteId') querySiteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.dockService.getStats(siteId, from, to);
  }
}
