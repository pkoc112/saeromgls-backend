/**
 * P0-5: PII(개인정보) 마스킹 유틸
 * 로그에 이메일/전화 평문 노출 방지
 */

/** a***@naver.com 형태로 이메일 로컬파트 일부만 노출 */
export function maskEmail(email?: string | null): string {
  if (!email) return '(none)';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 2))}${local[local.length - 1]}${domain}`;
}

/** 010-****-1234 형태 */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '(none)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/** 이름: 홍길동 → 홍*동 */
export function maskName(name?: string | null): string {
  if (!name) return '(none)';
  if (name.length <= 1) return '*';
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${'*'.repeat(name.length - 2)}${name[name.length - 1]}`;
}
