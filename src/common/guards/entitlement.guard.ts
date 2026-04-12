import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { FEATURE_KEY } from '../decorators/feature.decorator';
import { JwtPayload } from '../decorators/current-user.decorator';

/**
 * 플랜별 기능 제한 가드
 *
 * JWT에서 siteId 추출 -> Subscription 조회 -> Plan.features 배열에서 featureCode 존재 여부 확인
 * - 구독 상태가 ACTIVE 또는 TRIAL이 아니면 403
 * - Plan.features에 해당 featureCode가 없으면 403
 *
 * 사용법:
 *   @UseGuards(JwtAuthGuard, EntitlementGuard)
 *   @Feature('AI_INSIGHT')
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  private readonly logger = new Logger(EntitlementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.getAllAndOverride<string>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // @Feature() 데코레이터가 없으면 기능 체크 생략
    if (!requiredFeature) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) {
      throw new ForbiddenException('인증 정보가 없습니다');
    }

    // MASTER는 모든 기능 접근 가능
    if (user.role === 'MASTER') {
      return true;
    }

    if (!user.siteId) {
      throw new ForbiddenException('소속 사업장이 없습니다');
    }

    // 최신 구독 조회
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId: user.siteId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      // 구독 없으면 Free 플랜 기본 기능만 허용
      const freePlan = await this.prisma.plan.findUnique({ where: { code: 'FREE' } });
      if (freePlan && freePlan.features.includes(requiredFeature)) {
        return true;
      }
      throw new ForbiddenException(
        '이 기능은 유료 플랜에서만 사용할 수 있습니다. 플랜 업그레이드가 필요합니다.',
      );
    }

    // 상태 체크: ACTIVE 또는 TRIAL만 허용
    if (!['ACTIVE', 'TRIAL'].includes(subscription.status)) {
      throw new ForbiddenException(
        '구독이 활성 상태가 아닙니다. 플랜을 갱신해 주세요.',
      );
    }

    // TRIAL 만료 체크
    if (
      subscription.status === 'TRIAL' &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt < new Date()
    ) {
      throw new ForbiddenException(
        '무료 체험이 만료되었습니다. 플랜 업그레이드가 필요합니다.',
      );
    }

    // Plan.features 배열에서 featureCode 확인
    if (!subscription.plan.features.includes(requiredFeature)) {
      this.logger.warn(
        `Feature access denied: siteId=${user.siteId}, feature=${requiredFeature}, plan=${subscription.plan.code}`,
      );
      throw new ForbiddenException(
        `이 기능은 현재 플랜에서 사용할 수 없습니다. 플랜 업그레이드가 필요합니다.`,
      );
    }

    return true;
  }
}
