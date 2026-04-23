-- ================================================================
-- Subscription status 오타 통일 (CANCELED → CANCELLED)
-- 실행 시점: 2026-04-23 코드 배포 직후
--
-- 이유:
--   VALID_TRANSITIONS 및 DTO enum 은 'CANCELLED' (영국식, 2L)
--   과거 cancelSubscription() 코드는 'CANCELED' (미국식, 1L)로 저장
--   → 기존 DB 레코드 중 CANCELED가 남아 있으면 상태 머신이 예외를 던짐
--
-- 실행 방법:
--   Neon console → SQL Editor → 아래 쿼리 복붙 → Run
--   (프로덕션 DB에서 직접 실행)
--
-- 검증:
--   SELECT status, COUNT(*) FROM subscriptions GROUP BY status;
--   실행 후 'CANCELED' 행이 0이어야 함
-- ================================================================

-- 1) 영향 범위 먼저 확인 (SELECT)
SELECT id, site_id, status, updated_at
FROM subscriptions
WHERE status = 'CANCELED';

-- 2) 위 결과에 레코드가 있으면 다음 UPDATE 실행
UPDATE subscriptions
SET status = 'CANCELLED',
    updated_at = NOW()
WHERE status = 'CANCELED';

-- 3) 마이그레이션 후 검증 (모든 상태 집계)
SELECT status, COUNT(*) AS cnt
FROM subscriptions
GROUP BY status
ORDER BY status;
