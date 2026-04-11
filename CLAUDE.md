# Backend 하네스

## 배포
- `npx vercel --prod --yes` → saeromgls-api.vercel.app
- 배포 전: `npx prisma generate && npx tsc --noEmit`
- vercel.json의 outputDirectory: "public" 절대 변경 금지

## 새 모듈 체크리스트
1. `src/모듈명/` 디렉토리 생성 (module, service, controller, dto)
2. `app.module.ts` imports에 등록 ← 이것 빼먹으면 404
3. TypeScript 컴파일 확인
4. git commit + push 후 배포

## 코드 규칙
- JwtPayload.role: 'MASTER' | 'ADMIN' | 'SUPERVISOR' | 'WORKER' + siteId 포함
- RolesGuard: MASTER는 모든 @Roles 자동 통과
- generateToken: public, siteId 파라미터 포함, refreshToken 반환
- validateAdmin: MASTER/ADMIN/SUPERVISOR 허용
- mobile/workers: role notIn ['MASTER', 'ADMIN'] 필터
- admin/workers: role not 'MASTER' 필터
- seed-neon.js: ON CONFLICT에서 role 업데이트 금지
