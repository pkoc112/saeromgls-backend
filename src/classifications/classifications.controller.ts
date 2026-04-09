import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { ClassificationsService } from './classifications.service';
import { CreateClassificationDto } from './dto/create-classification.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class ClassificationsController {
  constructor(private readonly classificationsService: ClassificationsService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/classifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 전체 목록 (관리자)' })
  @ApiResponse({ status: 200, description: '분류 목록' })
  findAll() {
    return this.classificationsService.findAll();
  }

  @Post('admin/classifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 생성 (관리자 전용)' })
  @ApiResponse({ status: 201, description: '분류 생성 완료' })
  @ApiResponse({ status: 409, description: '코드 중복' })
  create(@Body() dto: CreateClassificationDto) {
    return this.classificationsService.create(dto);
  }

  @Patch('admin/classifications/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 수정 (관리자 전용)' })
  @ApiParam({ name: 'id', description: '분류 UUID' })
  @ApiResponse({ status: 200, description: '분류 수정 완료' })
  @ApiResponse({ status: 404, description: '분류 없음' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassificationDto,
  ) {
    return this.classificationsService.update(id, dto);
  }

  // ===================== Mobile Endpoints =====================

  @Get('mobile/classifications')
  @ApiTags('Mobile Classifications')
  @ApiOperation({
    summary: '활성 분류 목록 (모바일)',
    description: '인증 불필요. 작업 시작 시 분류 선택용.',
  })
  @ApiResponse({ status: 200, description: '활성 분류 목록 (정렬 순서)' })
  findActiveForMobile() {
    return this.classificationsService.findActiveForMobile();
  }
}
