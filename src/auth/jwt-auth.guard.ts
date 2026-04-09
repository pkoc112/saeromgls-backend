import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT 인증 가드
 * Bearer 토큰 기반 인증을 수행
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<T>(err: Error | null, user: T, info: Error | undefined): T {
    if (err || !user) {
      throw err || new UnauthorizedException('유효하지 않은 인증 토큰입니다');
    }
    return user;
  }
}
