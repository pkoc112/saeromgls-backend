import { PrismaService } from '../../prisma/prisma.service';

/**
 * 구독/청구·기능 권한(entitlement)은 항상 최상위(루트) Site 기준이다.
 *
 * 하위 사업장(parentSiteId 있음)은 자체 구독 레코드가 없으므로, 부모 체인을 따라
 * 루트 siteId를 찾아 구독/사용량/기능 권한을 조회해야 한다. 이를 하지 않으면
 * 하위 사업장 admin이 FREE로 강등(기능 차단)되거나, 반대로 부모가 SUSPENDED여도
 * 하위가 FREE 기능을 계속 쓰는 과금 우회가 발생한다.
 *
 * - 루트 사이트(parentSiteId 없음)는 입력 siteId를 그대로 반환 → 단일 사이트 운영(대구 등)은 동작 불변.
 * - 순환 참조/과도한 깊이는 방어(seen + depth 상한).
 */
export async function resolveBillingSiteId(
  prisma: PrismaService,
  siteId: string,
): Promise<string> {
  let current = siteId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 10; depth++) {
    if (seen.has(current)) break; // 순환 방어
    seen.add(current);
    const site = await prisma.site.findUnique({
      where: { id: current },
      select: { parentSiteId: true },
    });
    if (!site || !site.parentSiteId) return current;
    current = site.parentSiteId;
  }
  return current;
}
