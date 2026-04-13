import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET required in production');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'fallback-secret-for-dev',
    });
  }

  /**
   * JWT 토큰 검증 후 사용자 정보를 요청 객체에 주입
   * Passport가 자동으로 호출
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // 토큰에 포함된 작업자가 여전히 활성 상태인지 확인
    const worker = await this.prisma.worker.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, role: true },
    });

    if (!worker || worker.status !== 'ACTIVE') {
      throw new UnauthorizedException('비활성화된 계정이거나 존재하지 않는 사용자입니다');
    }

    return payload;
  }
}
