import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../decorators/current-user.decorator';
import { resolveBillingSiteId } from '../utils/billing-site';

/**
 * 구독 정지 게이트 (개통 분석 P1-5c)
 *
 * 미납/정지 센터가 신규 작업을 기록하지 못하도록 차단하는 "kill switch".
 *
 * 안전장치(이중):
 *  1) 환경변수 ENFORCE_SUBSCRIPTION_GATE !== 'true' 이면 항상 통과 (기본 OFF).
 *     → 운영자가 각 센터 구독상태를 확인한 뒤에만 켠다.
 *  2) 플래그가 켜져도 차단 대상은 **SUSPENDED / CANCELLED** (운영자가 의도적으로 끊은 상태)뿐.
 *     - 구독 레코드 없음(FREE 폴백, 예: 대구 자체운영) → 통과
 *     - TRIAL / ACTIVE / PAST_DUE(유예) / EXPIRED → 통과
 *     - MASTER / siteId 없음 → 통과 (다른 가드가 처리)
 *
 * 적용: 모바일 작업 '생성' 엔드포인트 (신규 작업 시작 차단). 진행 중 작업의
 *       종료/일시정지/재개는 허용해 교대 도중 stranding을 피한다.
 */
@Injectable()
export class SubscriptionGateGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionGateGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1) 기본 OFF — 운영자가 명시적으로 켤 때만 작동
    if (process.env.ENFORCE_SUBSCRIPTION_GATE !== 'true') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;

    // 인증/마스터/미배정은 차단하지 않음 (각각 다른 가드·정책이 처리)
    if (!user || user.role === 'MASTER' || !user.siteId) {
      return true;
    }

    // ★ 구독은 루트(청구) 사이트 기준 — 하위 사업장은 부모 구독 상태를 상속
    const billingSiteId = await resolveBillingSiteId(this.prisma, user.siteId);
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId: billingSiteId },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });

    // 구독 레코드 없음 = FREE 폴백(자체운영) → 차단 안 함
    if (!subscription) {
      return true;
    }

    // 운영자가 의도적으로 끊은 상태만 차단
    if (subscription.status === 'SUSPENDED' || subscription.status === 'CANCELLED') {
      this.logger.warn(
        `Subscription gate blocked: siteId=${user.siteId}, status=${subscription.status}`,
      );
      throw new ForbiddenException(
        '구독이 정지되어 새 작업을 기록할 수 없습니다. 관리자에게 문의해 주세요.',
      );
    }

    return true;
  }
}
