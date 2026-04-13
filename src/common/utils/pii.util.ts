import { encrypt, decrypt, isEncrypted } from './crypto.util';

// ══════════════════════════════════════════════
// PII (개인식별정보) 암호화/복호화 유틸리티
//
// Phase 1: phone 필드만 암호화 (phone은 조회 키로 사용되지 않음)
// Phase 2: email 암호화는 검색 인덱스 마이그레이션이 필요하여 별도 진행
//   - email은 findUnique(where: { email }) 로 사용되므로
//   - 암호화 시 blind index(SHA-256 해시) 컬럼 추가 필요
//   - 스키마 마이그레이션 + 기존 데이터 재색인 작업이 수반됨
// ══════════════════════════════════════════════

/**
 * Worker 객체의 PII 필드를 저장 전에 암호화합니다.
 * 이미 암호화된 필드는 건너뜁니다.
 *
 * @param data Worker 생성/수정 데이터 (Partial)
 * @returns 암호화된 PII 필드가 적용된 데이터
 */
export function encryptWorkerPII<T extends Record<string, unknown>>(data: T): T {
  const result = { ...data };

  // Phase 1: phone만 암호화
  if (result['phone'] && typeof result['phone'] === 'string' && !isEncrypted(result['phone'])) {
    (result as Record<string, unknown>)['phone'] = encrypt(result['phone']);
  }

  // Phase 2: email 암호화 — 검색 인덱스 마이그레이션 후 활성화
  // if (result['email'] && typeof result['email'] === 'string' && !isEncrypted(result['email'])) {
  //   (result as Record<string, unknown>)['email'] = encrypt(result['email']);
  // }

  return result;
}

/**
 * Worker 객체의 PII 필드를 조회 후 복호화합니다.
 * 암호화되지 않은 기존 데이터는 그대로 반환됩니다 (하위 호환).
 *
 * @param worker Worker 객체 (단건)
 * @returns PII 필드가 복호화된 Worker 객체
 */
export function decryptWorkerPII<T extends Record<string, unknown>>(worker: T): T {
  if (!worker) return worker;

  const result = { ...worker };

  // Phase 1: phone 복호화
  if (result['phone'] && typeof result['phone'] === 'string') {
    (result as Record<string, unknown>)['phone'] = decrypt(result['phone']);
  }

  // Phase 2: email 복호화 — 검색 인덱스 마이그레이션 후 활성화
  // if (result['email'] && typeof result['email'] === 'string') {
  //   (result as Record<string, unknown>)['email'] = decrypt(result['email']);
  // }

  return result;
}

/**
 * Worker 배열의 PII 필드를 일괄 복호화합니다.
 *
 * @param workers Worker 배열
 * @returns PII 필드가 복호화된 Worker 배열
 */
export function decryptWorkersPII<T extends Record<string, unknown>>(workers: T[]): T[] {
  if (!workers || !Array.isArray(workers)) return workers;
  return workers.map(decryptWorkerPII);
}
