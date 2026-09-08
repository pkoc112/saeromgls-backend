export function compareClassifications(
  a: { id: string; sortOrder: number; displayName: string },
  b: { id: string; sortOrder: number; displayName: string },
): number {
  const label = (name: string) => name.replace(/^\[.+?\]\s*/, '').replace(/\s*\[.+?\]\s*$/, '').trim();
  return Number(a.sortOrder) - Number(b.sortOrder)
    || label(a.displayName).localeCompare(label(b.displayName), 'ko')
    || a.id.localeCompare(b.id);
}
