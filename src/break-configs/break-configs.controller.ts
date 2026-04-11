import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { BreakConfigsService } from './break-configs.service';
import { CreateBreakConfigDto } from './dto/create-break-config.dto';
import { UpdateBreakConfigDto } from './dto/update-break-config.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class BreakConfigsController {
  constructor(private readonly breakConfigsService: BreakConfigsService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/break-configs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin BreakConfigs')
  @ApiOperation({ summary: '휴게시간 설정 목록 조회 (관리자)' })
  @ApiQuery({
    name: 'siteId',
    required: false,
    type: String,
    description: '현장 ID (없으면 전역 설정)',
  })
  @ApiResponse({ status: 200, description: '휴게시간 설정 목록' })
  findAll(@Query('siteId') siteId?: string) {
    return this.breakConfigsService.findAll(siteId);
  }

  @Post('admin/break-configs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin BreakConfigs')
  @ApiOperation({ summary: '휴게시간 설정 생성 (관리자 전용)' })
  @ApiResponse({ status: 201, description: '휴게시간 설정 생성 완료' })
  @ApiResponse({ status: 400, description: '유효성 검사 실패' })
  @ApiResponse({ status: 409, description: '시간 겹침' })
  create(@Body() dto: CreateBreakConfigDto) {
    return this.breakConfigsService.create(dto);
  }

  @Patch('admin/break-configs/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin BreakConfigs')
  @ApiOperation({ summary: '휴게시간 설정 수정 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '휴게시간 설정 UUID' })
  @ApiResponse({ status: 200, description: '휴게시간 설정 수정 완료' })
  @ApiResponse({ status: 404, description: '설정 없음' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBreakConfigDto,
  ) {
    return this.breakConfigsService.update(id, dto);
  }

  @Delete('admin/break-configs/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('Admin BreakConfigs')
  @ApiOperation({
    summary: '휴게시간 설정 삭제 (관리자 전용)',
    description: '소프트 삭제: isActive를 false로 변경합니다.',
  })
  @ApiParam({ name: 'id', description: '휴게시간 설정 UUID' })
  @ApiResponse({ status: 204, description: '삭제(비활성화) 완료' })
  @ApiResponse({ status: 404, description: '설정 없음' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.breakConfigsService.remove(id);
  }

  // ===================== Mobile Endpoints =====================

  @Get('mobile/break-configs')
  @ApiTags('Mobile BreakConfigs')
  @ApiOperation({
    summary: '전역 휴게시간 목록 (모바일)',
    description: '인증 불필요. 모바일 앱에서 휴게시간 표시용.',
  })
  @ApiResponse({ status: 200, description: '활성 휴게시간 목록 (간소화)' })
  findForMobile() {
    return this.breakConfigsService.findForMobile();
  }
}
