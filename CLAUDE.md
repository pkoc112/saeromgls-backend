# Backend 하네스

## 배포
- `npx vercel --prod --yes` → saeromgls-api.vercel.app
- 배포 전: `npx prisma generate && npx tsc --noEmit`
- vercel.json의 outputDirectory: "public" 절대 변경 금지

## 새 모듈 체크리스트
1. `src/모듈명/` 디렉토리 생성 (module, service, controller, dto)
2. `app.module.ts` imports에 등록 ← 이것 빼먹으면 404
3. **신규 service를 다른 module이 사용한다면, 그 module의 imports에도 추가** ← 안 하면 부팅 자체 실패 (2026-05-28 사고)
4. **export [신규Service]** 추가 (다른 module이 inject 가능하려면 module의 exports에 반드시)
5. TypeScript 컴파일 확인
6. git commit + push 후 배포
7. **배포 직후 `curl https://saeromgls-api.vercel.app/api/health` 200 확인** ← 부팅 검증 필수

## 사고 교훈 (2026-05-28)
- **Neon Free tier compute 한도**: 디버깅 + 마이그레이션 반복으로 빠르게 소진. Launch 플랜 ($19/월) 사용 중. 큰 디버깅 작업 자제.
- **부팅 실패는 build 후에야 드러남**: tsc 통과 + nest build 통과 ≠ 런타임 OK. 배포 후 health check 필수.
- **롤백 시점 미리 표시**: 위험한 변경 직전 commit hash 기억 (vercel promote로 롤백 가능).

## 코드 규칙
- JwtPayload.role: 'MASTER' | 'ADMIN' | 'SUPERVISOR' | 'WORKER' + siteId 포함
- RolesGuard: MASTER는 모든 @Roles 자동 통과
- generateToken: public, siteId 파라미터 포함, refreshToken 반환
- validateAdmin: MASTER/ADMIN/SUPERVISOR 허용
- mobile/workers: role notIn ['MASTER', 'ADMIN'] 필터
- admin/workers: role not 'MASTER' 필터
- seed-neon.js: ON CONFLICT에서 role 업데이트 금지
