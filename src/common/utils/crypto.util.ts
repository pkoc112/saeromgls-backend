import * as crypto from 'crypto';

// ══════════════════════════════════════════════
// AES-256-GCM 암호화 유틸리티
// Phase 1: phone 필드 암호화에 사용
// Phase 2: email 암호화 (검색 인덱스 마이그레이션 필요)
// ══════════════════════════════════════════════

const ALGORITHM = 'aes-256-gcm';

/**
 * 암호화 키를 환경변수에서 가져와 32바이트로 정규화합니다.
 * 우선순위: PII_ENCRYPTION_KEY > JWT_SECRET > 개발용 폴백
 *
 * 주의: 프로덕션에서는 PII_ENCRYPTION_KEY를 반드시 별도 설정해야 합니다.
 * JWT_SECRET과 분리하면 키 로테이션 시 JWT에 영향 없이 PII 재암호화 가능.
 */
function getKey(): Buffer {
  const raw =
    process.env.PII_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'dev-fallback-key-32chars!!!!!!!!';
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * 평문을 AES-256-GCM으로 암호화합니다.
 * 반환 형식: `{iv}:{authTag}:{ciphertext}` (모두 hex)
 *
 * @param text 암호화할 평문
 * @returns 암호화된 문자열 또는 빈/null 입력 시 원본 반환
 */
export function encrypt(text: string): string {
  if (!text) return text;
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * AES-256-GCM 암호문을 복호화합니다.
 * 복호화 실패 시 원본을 그대로 반환합니다 (아직 암호화되지 않은 데이터 호환).
 *
 * @param encryptedText 암호화된 문자열 (`iv:tag:ciphertext` 형식)
 * @returns 복호화된 평문 또는 원본 (미암호화/실패 시)
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;
  try {
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !tagHex || !encrypted) return encryptedText;

    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // 복호화 실패 시 원본 반환 (아직 암호화되지 않은 기존 데이터)
    return encryptedText;
  }
}

/**
 * 문자열이 암호화된 형식인지 판별합니다.
 * iv(32 hex chars) : tag(32 hex chars) : ciphertext 형식을 확인합니다.
 *
 * @param text 확인할 문자열
 * @returns 암호화 형식이면 true
 */
export function isEncrypted(text: string): boolean {
  if (!text) return false;
  const parts = text.split(':');
  // iv = 16 bytes = 32 hex chars, tag = 16 bytes = 32 hex chars
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}
