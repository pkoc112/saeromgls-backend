import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';

/**
 * Sentry 예외 캡처 필터
 * HttpException이 아닌 예상치 못한 에러만 Sentry에 전송
 * 기존 에러 핸들링은 건드리지 않고, 에러를 다시 throw하여 다음 필터로 전달
 */
@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SentryExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // HttpException(4xx, 5xx 의도적 응답)은 Sentry에 보내지 않음
    if (!(exception instanceof HttpException)) {
      this.logger.warn(
        `[Sentry] Capturing unexpected exception: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      Sentry.captureException(exception);
    }

    // 에러를 다시 throw하여 HttpExceptionFilter 등 후속 필터가 처리하도록 함
    throw exception;
  }
}
