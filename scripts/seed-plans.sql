-- ================================================================
-- Plan(요금제) 시드 — 신규 환경 부트스트랩 전용
--
-- ✅ 안전 설계:
--   • 새 플랜은 INSERT (DO NOTHING)
--   • 기존 플랜은 features를 절대 건드리지 않음
--     → 운영자가 수동 추가한 항목(DASHBOARD/WORK_ITEMS/WORKERS, BASIC의
--       AI_INSIGHT 등)이 유실되지 않는다.
--   • 가격·한도·is_active 만 EXCLUDED 값으로 갱신 가능 (선택적)
--
-- 운영 features 변경은 SQL이 아니라 add-only 스크립트로:
--     npx tsx scripts/fix-missing-plan-features.ts
--     npx tsx scripts/audit-plan-features.ts        (점검만)
--
-- @Feature() 매핑 (코드 사용처):
--   ACTIVITY_LOGS    activity-logs.controller.ts
--   AI_INSIGHT       ai.controller.ts
--   CSV_EXPORT       dashboard.controller.ts (export)
--   DATA_PROTECTION  data-protection.controller.ts
--   INCENTIVE        incentives.controller.ts
--   PERFORMANCE      performance.controller.ts
--   REPORTS          reports.controller.ts
--   ADVANCED_REPORT  (현재 코드에서 사용 안 됨, 미래 확장 자리)
--   API_ACCESS       (현재 코드에서 사용 안 됨, 미래 확장 자리)
-- ================================================================

INSERT INTO plans (id, name, code, max_workers, max_sites, features, price_monthly, price_yearly, is_active, created_at)
VALUES
  -- Free: 구독 없을 때 fallback. 기능 없음.
  (gen_random_uuid(), 'Free', 'FREE', 5, 1, ARRAY[]::text[], 0, 0, true, NOW()),

  -- Basic: 기본 운영 (작업기록 + 성과 + 인센티브 + 로그/CSV/리포트)
  (gen_random_uuid(), 'Basic', 'BASIC', 30, 1,
    ARRAY['PERFORMANCE','INCENTIVE','CSV_EXPORT','REPORTS','ACTIVITY_LOGS']::text[],
    49000, 490000, true, NOW()),

  -- Pro: Basic + AI/상세 리포트/데이터 보호
  (gen_random_uuid(), 'Pro', 'PRO', 100, 5,
    ARRAY['PERFORMANCE','INCENTIVE','CSV_EXPORT','REPORTS','ACTIVITY_LOGS',
          'AI_INSIGHT','ADVANCED_REPORT','DATA_PROTECTION']::text[],
    149000, 1490000, true, NOW()),

  -- Enterprise: 모든 기능 + 외부 API
  (gen_random_uuid(), 'Enterprise', 'ENTERPRISE', 1000, 50,
    ARRAY['PERFORMANCE','INCENTIVE','CSV_EXPORT','REPORTS','ACTIVITY_LOGS',
          'AI_INSIGHT','ADVANCED_REPORT','DATA_PROTECTION','API_ACCESS']::text[],
    0, 0, true, NOW())

-- ⚠️  features는 절대 EXCLUDED로 덮어쓰지 않는다. 운영 추가분 보존.
ON CONFLICT (code) DO NOTHING;

-- 가격·한도·활성 상태만 별도로 동기화 (features 제외)
-- 이 UPDATE도 실행하기 싫으면 통째로 주석 처리.
UPDATE plans p SET
  max_workers   = src.max_workers,
  max_sites     = src.max_sites,
  price_monthly = src.price_monthly,
  price_yearly  = src.price_yearly,
  is_active     = src.is_active
FROM (VALUES
  ('FREE',       5,    1,      0,      0, true),
  ('BASIC',      30,   1,  49000, 490000, true),
  ('PRO',        100,  5, 149000, 1490000, true),
  ('ENTERPRISE', 1000, 50,     0,      0, true)
) AS src(code, max_workers, max_sites, price_monthly, price_yearly, is_active)
WHERE p.code = src.code;

-- 검증
SELECT code, name, max_workers, max_sites, features, price_monthly
FROM plans
ORDER BY price_monthly;
