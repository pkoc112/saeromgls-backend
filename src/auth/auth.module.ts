import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: (() => {
        if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
          throw new Error('JWT_SECRET required in production');
        }
        return process.env.JWT_SECRET || 'fallback-secret-for-dev';
      })(),
      signOptions: {
        // ★ Access TTL 1h (CLAUDE.md 규정), refresh로 갱신
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
