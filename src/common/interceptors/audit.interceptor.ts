import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';

/**
 * 감사 로깅 인터셉터
 * 요청/응답 메타데이터를 로깅하고, 작업 항목 변경 시 감사 정보를 캡처
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const url = request.url;
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const userAgent = request.headers['user-agent'] || 'unknown';
    const user = (request as unknown as Record<string, unknown>).user as
      | { sub: string; role: string }
      | undefined;

    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - now;
          this.logger.log(
            `[${method}] ${url} - ${user?.sub || 'anonymous'} (${user?.role || 'N/A'}) - ${duration}ms - ${ip}`,
          );
        },
        error: (err: Error) => {
          const duration = Date.now() - now;
          this.logger.warn(
            `[${method}] ${url} - ${user?.sub || 'anonymous'} - ${duration}ms - ERROR: ${err.message}`,
          );
        },
      }),
    );
  }
}
