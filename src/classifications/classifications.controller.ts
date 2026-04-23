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
  ForbiddenException,
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
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 생성 (사업장 자동 배정)' })
  @ApiResponse({ status: 201, description: '분류 생성 완료' })
  @ApiResponse({ status: 409, description: '코드 중복' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateClassificationDto,
  ) {
    // ADMIN: 자기 사업장 자동 배정, MASTER: dto.siteId 사용 가능
    let siteId: string | undefined;
    if (user.role === 'MASTER') {
      siteId = dto.siteId || undefined; // MASTER는 명시적 siteId 또는 전역(null) 생성 가능
    } else {
      // ADMIN은 반드시 자기 사업장 siteId가 있어야 함 (전역 분류 생성 차단)
      if (!user.siteId) {
        throw new ForbiddenException(
          '사업장이 배정되지 않은 관리자는 분류를 생성할 수 없습니다',
        );
      }
      siteId = user.siteId;
    }
    return this.classificationsService.create(dto, siteId);
  }

  @Patch('admin/classifications/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth('jwt')
  @ApiTags('Admin Classifications')
  @ApiOperation({ summary: '분류 수정 (관리자 전용, 소유권 검증)' })
  @ApiParam({ name: 'id', description: '분류 UUID' })
  @ApiResponse({ status: 200, description: '분류 수정 완료' })
  @ApiResponse({ status: 403, description: '권한 없음 (다른 사업장 또는 전역 분류)' })
  @ApiResponse({ status: 404, description: '분류 없음' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassificationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.classificationsService.update(id, dto, {
      role: user.role,
      siteId: user.siteId,
    });
  }

  // ===================== Mobile Endpoints =====================

  @Get('mobile/classifications')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiTags('Mobile Classifications')
  @ApiOperation({
    summary: '활성 분류 목록 (모바일, JWT siteId 강제)',
    description:
      'JWT 토큰의 siteId로 해당 사업장 분류만 반환. MASTER만 Query siteId로 임의 조회 가능.',
  })
  @ApiQuery({ name: 'siteId', required: false, description: 'MASTER 전용' })
  @ApiResponse({ status: 200, description: '활성 분류 목록 (정렬 순서)' })
  findActiveForMobile(
    @CurrentUser() user: JwtPayload,
    @Query('siteId') querySiteId?: string,
  ) {
    // ★ siteId 격리: MASTER는 Query로 임의 조회, 나머지는 JWT siteId 강제
    const siteId = user.role === 'MASTER' ? querySiteId : user.siteId;
    return this.classificationsService.findActiveForMobile(siteId);
  }
}
