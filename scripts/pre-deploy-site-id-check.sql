-- ================================================================
-- 배포 전 필수 점검: ADMIN/SUPERVISOR/WORKER 계정 중 siteId NULL 검사
-- 실행 시점: resolveSiteId 강화 배포 직전 (Neon SQL Editor)
--
-- 이유:
--   resolveSiteId() 가 이제 "MASTER 아닌데 siteId 없는 계정"을 403 차단.
--   DB에 siteId NULL인 ADMIN/SUPERVISOR/WORKER가 있으면 그 계정은
--   배포 직후 모든 조회 API 에서 차단되어 서비스 불가 상태가 됨.
--
-- 실행 방법:
--   Neon console → SQL Editor → 아래 1번 쿼리 실행 → 결과 확인
--   - 결과 0건: 배포 안전 (그대로 진행)
--   - 결과 >= 1건: 아래 2번 옵션 중 선택
-- ================================================================

-- [1] 영향 범위 확인
SELECT id, email, employee_code, name, role, site_id, status, created_at
FROM workers
WHERE role IN ('ADMIN', 'SUPERVISOR', 'WORKER')
  AND site_id IS NULL
ORDER BY role, created_at DESC;

-- [2-a] 해당 계정에 siteId 지정 (권장 — 어느 사업장인지 명확할 때)
-- UPDATE workers
-- SET site_id = '대상_사업장_UUID'
-- WHERE id = '계정_ID';

-- [2-b] 비활성화 (판단 어려울 때)
-- UPDATE workers
-- SET status = 'INACTIVE'
-- WHERE id = '계정_ID';

-- [2-c] MASTER로 승격 (소유주 계정 — 매우 신중하게)
-- UPDATE workers
-- SET role = 'MASTER'
-- WHERE id = '계정_ID' AND email = '확인된_MASTER_이메일';

-- [3] 배포 후 재확인
SELECT role, COUNT(*) FILTER (WHERE site_id IS NULL) AS null_count,
       COUNT(*) FILTER (WHERE site_id IS NOT NULL) AS has_site_count
FROM workers
WHERE role IN ('ADMIN', 'SUPERVISOR', 'WORKER')
GROUP BY role;
