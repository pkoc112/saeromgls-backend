import { readFileSync } from 'fs';
import { join } from 'path';

describe('work item row lock schema compatibility', () => {
  it('uses a bound text parameter for the Prisma String id, without a UUID cast', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model WorkItem \{([\s\S]*?)\n\}/)![1];
    const id = model.split('\n').find((line) => /^\s+id\s/.test(line))!;
    expect(id).toMatch(/String\s+@id/);
    expect(id).not.toContain('@db.Uuid');
    const source = readFileSync(join(__dirname, 'work-items.service.ts'), 'utf8');
    expect(source).toContain('WHERE id = ${id} FOR UPDATE');
    expect(source).not.toContain('WHERE id = ${id}::uuid FOR UPDATE');
  });
});
