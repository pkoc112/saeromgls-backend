import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { StartTrialDto } from './dto/create-subscription.dto';

@Controller('admin')
@ApiTags('Subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // ──────────────────────────────────────────────
  // GET /api/admin/plans — 플랜 목록 (공개)
  // ──────────────────────────────────────────────
  @Get('plans')
  @ApiOperation({
    summary: '구독 플랜 목록 조회',
    description: '활성화된 모든 구독 플랜을 조회합니다. 인증 불필요.',
  })
  @ApiResponse({ status: 200, description: '플랜 목록' })
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  // ──────────────────────────────────────────────
  // GET /api/admin/subscriptions — 현재 구독 상태 (JWT)
  // ──────────────────────────────────────────────
  @Get('subscriptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '현재 사이트 구독 상태 조회',
    description: '로그인한 사용자의 소속 사업장 구독 정보를 조회합니다.',
  })
  @ApiResponse({ status: 200, description: '구독 상태 정보' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  getSubscription(@CurrentUser() user: JwtPayload) {
    if (!user.siteId) {
      throw new BadRequestException('소속 사업장이 없습니다');
    }
    return this.subscriptionsService.getSubscription(user.siteId);
  }

  // ──────────────────────────────────────────────
  // POST /api/admin/subscriptions/start-trial — 14일 무료 체험 (JWT)
  // ──────────────────────────────────────────────
  @Post('subscriptions/start-trial')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MASTER', 'ADMIN')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: '14일 무료 체험 시작',
    description:
      '지정 사업장에 대해 14일 무료 체험을 시작합니다. 사업장당 1회만 가능.',
  })
  @ApiResponse({ status: 201, description: '체험 시작 성공' })
  @ApiResponse({ status: 400, description: '이미 구독/체험 중' })
  @ApiResponse({ status: 403, description: '이미 체험 사용 완료' })
  startTrial(@Body() dto: StartTrialDto) {
    return this.subscriptionsService.startTrial(dto.siteId, dto.planCode);
  }
}
