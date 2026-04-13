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
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ClassificationsService } from './classifications.service';
import { CreateClassificationDto } from './dto/create-classification.dto';
import { UpdateClassificationDto } from './dto/update-classification.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveSiteId } from '../common/utils/site-scope';

@Controller()
export class ClassificationsController {
  constructor(private readonly classificationsService: ClassificationsService) {}

  // ===================== Admin Endpoints =====================

  @Get('admin/classifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 목록 (사업장 격리)' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiResponse({ status: 200, description: '분류 목록' })
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
  ) {
    const siteId = resolveSiteId(user, querySiteId);
    return this.classificationsService.findAll(siteId);
  }

  @Post('admin/classifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 생성 (사업장 자동 배정)' })
  @ApiResponse({ status: 201, description: '분류 생성 완료' })
  @ApiResponse({ status: 409, description: '코드 중복' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateClassificationDto,
  ) {
    // ADMIN/SUPERVISOR: 자기 사업장 자동 배정, MASTER: dto.siteId 사용 가능
    const siteId = user.role === 'MASTER'
      ? (dto.siteId || undefined)
      : user.siteId;
    return this.classificationsService.create(dto, siteId);
  }

  @Patch('admin/classifications/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPERVISOR')
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
    summary: '활성 분류 목록 (모바일, siteId 격리)',
    description: '인증 불필요. siteId로 해당 사업장 분류만 반환.',
  })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiResponse({ status: 200, description: '활성 분류 목록 (정렬 순서)' })
  findActiveForMobile(@Query('siteId') siteId?: string) {
    return this.classificationsService.findActiveForMobile(siteId);
  }
}
