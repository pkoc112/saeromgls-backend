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
import { InboundService } from './inbound.service';
import { CreateInboundSessionDto } from './dto/create-inbound-session.dto';
import { QueryInboundDto } from './dto/query-inbound.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@ApiTags('Admin Inbound Sessions')
@ApiBearerAuth('jwt')
@Controller('admin/inbound-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InboundController {
  constructor(private readonly inboundService: InboundService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '입고 세션 목록 조회',
    description: '입고 세션을 페이지네이션으로 조회합니다. 상태/날짜 필터 지원.',
  })
  @ApiResponse({ status: 200, description: '입고 세션 목록 + 페이지네이션 메타' })
  findAll(
    @Query() query: QueryInboundDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, query.siteId);
    return this.inboundService.findAll(siteId, query);
  }

  @Post()
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({
    summary: '입고 세션 생성 (수동)',
    description: '수동으로 입고 세션을 생성합니다.',
  })
  @ApiResponse({ status: 201, description: '입고 세션 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 요청' })
  create(
    @Body() dto: CreateInboundSessionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const siteId = resolveSiteId(user, (dto as any).siteId) || user.siteId || '';
    if (!siteId) {
      throw new BadRequestException('사업장을 선택해주세요 (siteId 필수)');
    }
    return this.inboundService.create(dto, siteId);
  }

  @Post('upload')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '엑셀 업로드로 입고 세션 생성',
    description: '파싱된 엑셀 데이터를 받아 입고 세션을 생성합니다.',
  })
  @ApiResponse({ status: 201, description: '엑셀 기반 입고 세션 생성 완료' })
  @ApiResponse({ status: 400, description: '유효하지 않은 엑셀 데이터' })
  async uploadExcel(
    @Body() fileData: any,
    @CurrentUser() user: JwtPayload,
  ) {
    // body.siteId 또는 JWT siteId, MASTER는 첫 번째 활성 사업장 자동 사용
    let siteId = resolveSiteId(user, fileData.siteId) || user.siteId || '';
    if (!siteId) {
      const firstSite = await this.inboundService.getFirstActiveSiteId();
      siteId = firstSite || '';
    }
    if (!siteId) {
      throw new BadRequestException('사업장을 선택해주세요 (siteId 필수)');
    }
    return this.inboundService.uploadExcel(siteId, fileData, user.sub);
  }

  @Post(':id/approve')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '입고 세션 승인',
    description: '대기 중인 입고 세션을 승인합니다.',
  })
  @ApiParam({ name: 'id', description: '입고 세션 UUID' })
  @ApiResponse({ status: 200, description: '승인 완료' })
  @ApiResponse({ status: 400, description: '대기 상태가 아닌 세션' })
  @ApiResponse({ status: 404, description: '세션 없음' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.inboundService.approve(id, user.sub);
  }

  @Post(':id/reject')
  @Roles('ADMIN')
  @ApiOperation({
    summary: '입고 세션 반려',
    description: '대기 중인 입고 세션을 반려합니다.',
  })
  @ApiParam({ name: 'id', description: '입고 세션 UUID' })
  @ApiResponse({ status: 200, description: '반려 완료' })
  @ApiResponse({ status: 400, description: '대기 상태가 아닌 세션' })
  @ApiResponse({ status: 404, description: '세션 없음' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string,
  ) {
    return this.inboundService.reject(id, reason);
  }
}
