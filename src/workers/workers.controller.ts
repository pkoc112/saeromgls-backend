import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { WorkersService } from './workers.service';
import { CreateWorkerDto } from './dto/create-worker.dto';
import { UpdateWorkerDto } from './dto/update-worker.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class WorkersController {
  constructor(private readonly workersService: WorkersService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/workers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 목록 조회 (관리자)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '페이지 번호 (기본: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '페이지당 항목 수 (기본: 20)' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE'], description: '상태 필터' })
  @ApiResponse({ status: 200, description: '작업자 목록 + 페이지네이션 메타' })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ) {
    return this.workersService.findAll({ page, limit, status });
  }

  @Post('admin/workers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 생성 (관리자 전용)' })
  @ApiResponse({ status: 201, description: '작업자 생성 완료' })
  @ApiResponse({ status: 409, description: '사번 중복' })
  create(@Body() dto: CreateWorkerDto) {
    return this.workersService.create(dto);
  }

  @Patch('admin/workers/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Workers')
  @ApiOperation({ summary: '작업자 정보 수정 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '작업자 UUID' })
  @ApiResponse({ status: 200, description: '작업자 수정 완료' })
  @ApiResponse({ status: 404, description: '작업자 없음' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkerDto,
  ) {
    return this.workersService.update(id, dto);
  }

  // ===================== Mobile Endpoints =====================

  @Get('mobile/workers')
  @ApiTags('Mobile Workers')
  @ApiOperation({
    summary: '활성 작업자 목록 (모바일)',
    description: '인증 불필요. PIN 로그인 화면에서 작업자 선택용.',
  })
  @ApiResponse({ status: 200, description: '활성 작업자 목록 (최소 필드)' })
  findActiveForMobile() {
    return this.workersService.findActiveForMobile();
  }
}
