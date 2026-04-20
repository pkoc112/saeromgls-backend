import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 전역 API 접두사
  app.setGlobalPrefix('api');

  // P0-1: CORS allowlist — CSRF 방어 (이전 `origin: true`는 모든 도메인 허용)
  const allowedOrigins = [
    'https://sae-work.com',
    'https://www.sae-work.com',
    'https://saeromgls-dashboard.vercel.app',
    /^https:\/\/saeromgls-dashboard.*\.vercel\.app$/, // Preview 배포
    /^http:\/\/localhost:\d+$/, // 로컬 개발 (3000, 3001 등)
    /^http:\/\/127\.0\.0\.1:\d+$/,
  ];
  app.enableCors({
    origin: (origin, cb) => {
      // origin 없음 = 모바일 앱 / 서버간 호출 / Postman 허용
      if (!origin) return cb(null, true);
      const isAllowed = allowedOrigins.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin),
      );
      if (isAllowed) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    credentials: true,
  });

  // 전역 유효성 검사 파이프
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 전역 예외 필터
  app.useGlobalFilters(new HttpExceptionFilter());

  // Swagger 문서 설정
  const config = new DocumentBuilder()
    .setTitle('작업현황 공유 모바일 API')
    .setDescription(
      '작업자 공유 현황 모바일 어플리케이션 백엔드 API\n\n' +
        '- Mobile: 모바일 앱용 엔드포인트 (PIN 인증)\n' +
        '- Admin: 관리자 웹 대시보드용 엔드포인트 (JWT 인증)',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '관리자/반장 JWT 토큰',
      },
      'jwt',
    )
    .addTag('Admin Auth', '관리자 인증')
    .addTag('Mobile Auth', '모바일 인증')
    .addTag('Admin Workers', '관리자 - 작업자 관리')
    .addTag('Mobile Workers', '모바일 - 작업자 조회')
    .addTag('Admin Classifications', '관리자 - 분류 관리')
    .addTag('Mobile Classifications', '모바일 - 분류 조회')
    .addTag('Mobile Work Items', '모바일 - 작업 기록')
    .addTag('Admin Work Items', '관리자 - 작업 관리')
    .addTag('Admin Audit Logs', '관리자 - 감사 로그')
    .addTag('Admin Dashboard', '관리자 - 대시보드')
    .addTag('Admin AI', '관리자 - AI 인사이트')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application running on: http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
