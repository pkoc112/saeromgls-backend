-- ================================================================
-- Plan(요금제) 시드 — 1회 실행 (Neon SQL Editor)
-- 이미 있는 플랜은 ON CONFLICT 로 features만 업데이트
--
-- features 배열은 EntitlementGuard 가 @Feature() 데코레이터와 매칭
-- 코드와 동일하게 유지해야 함:
--   AI_INSIGHT     — AI 인사이트(주간요약/이상탐지/난이도)
--   INCENTIVE      — 인센티브 정책/점수/이의/지급
--   ADVANCED_REPORT — 상세 리포트
--   API_ACCESS     — 외부 API 연동
-- ================================================================

INSERT INTO plans (id, name, code, max_workers, max_sites, features, price_monthly, price_yearly, is_active, created_at)
VALUES
  -- Free: 기능 없음 (구독 0건일 때 fallback)
  (gen_random_uuid(), 'Free', 'FREE', 5, 1, ARRAY[]::text[], 0, 0, true, NOW()),
  -- Basic: 인센티브 + 기본 리포트
  (gen_random_uuid(), 'Basic', 'BASIC', 30, 1, ARRAY['INCENTIVE']::text[], 49000, 490000, true, NOW()),
  -- Pro: 인센티브 + AI 인사이트 + 고급 리포트
  (gen_random_uuid(), 'Pro', 'PRO', 100, 5, ARRAY['INCENTIVE', 'AI_INSIGHT', 'ADVANCED_REPORT']::text[], 149000, 1490000, true, NOW()),
  -- Enterprise: 모든 기능
  (gen_random_uuid(), 'Enterprise', 'ENTERPRISE', 1000, 50, ARRAY['INCENTIVE', 'AI_INSIGHT', 'ADVANCED_REPORT', 'API_ACCESS']::text[], 0, 0, true, NOW())
ON CONFLICT (code) DO UPDATE
SET features = EXCLUDED.features,
    max_workers = EXCLUDED.max_workers,
    max_sites = EXCLUDED.max_sites,
    price_monthly = EXCLUDED.price_monthly,
    price_yearly = EXCLUDED.price_yearly,
    is_active = EXCLUDED.is_active;

-- 검증: 시드 완료 후 확인
SELECT code, name, features, price_monthly FROM plans ORDER BY price_monthly;
