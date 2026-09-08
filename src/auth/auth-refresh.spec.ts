import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('refresh error classification', () => {
  function service(error: Error, invalidJwt = false) {
    const service = Object.create(AuthService.prototype) as AuthService;
    Object.assign(service, {
      getRefreshSecret: () => 'test-only',
      jwtService: { verify: () => { if (invalidJwt) throw error; return { sub: 'worker' }; } },
      prisma: { refreshToken: { findUnique: async () => { throw error; } } },
    });
    return service;
  }
  it('does not misreport database failure as session expiration', async () => {
    const error = new Error('database unavailable');
    await expect(service(error).refreshAccessToken('test')).rejects.toBe(error);
  });
  it.each(['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'])('returns 401 for %s', async (name) => {
    await expect(service(Object.assign(new Error('invalid'), { name }), true).refreshAccessToken('test')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
