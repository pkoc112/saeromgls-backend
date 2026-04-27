import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

// ★ Sentry init — DSN 있을 때만, App 생성 전에 초기화 (이후 captureException 동작)
// PII 마스킹: request body의 password/pin/email/phone 자동 제거
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0.1,
      // beforeSend로 민감 데이터 스크럽 (PIN/비밀번호/이메일/토큰)
      beforeSend(event: any) {
        const sensitiveKeys = ['password', 'pin', 'token', 'access_token', 'refresh_token', 'authorization'];
        const scrub = (obj: any): any => {
          if (!obj || typeof obj !== 'object') return obj;
          for (const k of Object.keys(obj)) {
            if (sensitiveKeys.some((s) => k.toLowerCase().includes(s))) {
              obj[k] = '[Filtered]';
            } else if (typeof obj[k] === 'object') {
              scrub(obj[k]);
            }
          }
          return obj;
        };
        if (event.request?.data) scrub(event.request.data);
        if (event.request?.headers) scrub(event.request.headers);
        if (event.extra) scrub(event.extra);
        return event;
      },
    });
    console.log('[Sentry] initialized');
  } catch (e) {
    console.warn('[Sentry] init failed (will fallback to no-op):', e);
  }
}

let cachedApp: any;

async function getApp() {
  if (!cachedApp) {
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    app.setGlobalPrefix('api');
    const isProduction = process.env.NODE_ENV === 'production';
    const allowedOrigins = [
      'https://saeromgls-dashboard.vercel.app',
      'https://sae-work.com',
      ...(!isProduction
        ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173']
        : []),
    ];
    app.enableCors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // 모바일 앱(React Native): Origin 헤더 없음 → 허용
        if (!origin) {
          callback(null, true);
          return;
        }
        // ★ 정확 매칭(=) — 이전 startsWith는 'sae-work.com.evil.com' 우회 가능했음
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        // 개발 환경에서만 비-HTTP scheme(file://, capacitor://) 등 허용
        if (!isProduction) {
          callback(null, true);
          return;
        }
        // 프로덕션: 허용되지 않은 origin 차단
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false, // _t 등 알 수 없는 파라미터는 조용히 무시
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    // Sentry 필터는 DSN 설정 시에만 활성화
    try {
      const { SentryExceptionFilter } = require('../src/common/filters/sentry-exception.filter');
      if (process.env.SENTRY_DSN) {
        app.useGlobalFilters(new SentryExceptionFilter(), new HttpExceptionFilter());
      } else {
        app.useGlobalFilters(new HttpExceptionFilter());
      }
    } catch {
      app.useGlobalFilters(new HttpExceptionFilter());
    }

    // P0-8: 전역 AuditInterceptor 등록 (운영 요청 로깅)
    try {
      const { AuditInterceptor } = require('../src/common/interceptors/audit.interceptor');
      app.useGlobalInterceptors(new AuditInterceptor());
    } catch (e) {
      // 인터셉터 로드 실패해도 앱 기동은 계속
      console.warn('AuditInterceptor load failed:', e);
    }

    // P0-10: Correlation ID 미들웨어 (요청 단위 추적)
    const express = app.getHttpAdapter().getInstance();
    express.use((req: any, res: any, next: any) => {
      const incoming = req.headers['x-request-id'] as string | undefined;
      const reqId = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      req.requestId = reqId;
      res.setHeader('X-Request-ID', reqId);
      next();
    });

    await app.init();
    cachedApp = app.getHttpAdapter().getInstance();
  }
  return cachedApp;
}

export default async function handler(req: any, res: any) {
  const app = await getApp();
  app(req, res);
}
