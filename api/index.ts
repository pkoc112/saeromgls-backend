import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

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
        // 모바일 앱: origin 없음 또는 file://, null, capacitor:// 등 비-HTTP origin 허용
        if (!origin || origin === 'null' || !origin.startsWith('http')) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.some((o) => origin.startsWith(o))) {
          callback(null, true);
        } else if (!isProduction) {
          callback(null, true);
        } else {
          // 프로덕션: 허용되지 않은 origin 차단
          callback(new Error(`Origin ${origin} not allowed by CORS`));
        }
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
    await app.init();
    cachedApp = app.getHttpAdapter().getInstance();
  }
  return cachedApp;
}

export default async function handler(req: any, res: any) {
  const app = await getApp();
  app(req, res);
}
