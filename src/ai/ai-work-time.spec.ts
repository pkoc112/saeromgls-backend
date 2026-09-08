import { AiService } from './ai.service';
import { Logger } from '@nestjs/common';

describe('AI input net work time', () => {
  const env = { ...process.env };
  let service: AiService;
  let prisma: any;
  let call: jest.SpyInstance;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    prisma = {
      workItem: { findMany: jest.fn().mockResolvedValue([{
        id: 'work-a', status: 'ENDED', startedAt: new Date('2026-09-08T11:00:00+09:00'), endedAt: new Date('2026-09-08T14:00:00+09:00'),
        notes: null, volume: '3', quantity: 10, classification: { code: 'PICK', displayName: 'Picking' },
        startedByWorker: { employeeCode: 'W1', siteId: 'site-a' }, assignments: [],
      }]) },
      breakConfig: { findMany: jest.fn().mockResolvedValue([{ siteId: 'site-a', startHour: 12, startMin: 0, endHour: 13, endMin: 0 }]) },
      dashboardInsight: { create: jest.fn().mockResolvedValue({ id: 'insight-1' }) },
      predictionLog: { create: jest.fn().mockResolvedValue({ id: 'prediction-1' }) },
    };
    service = new AiService(prisma);
    jest.spyOn(service as any, 'ensureClientReady').mockImplementation(() => {});
    call = jest.spyOn(service as any, 'callClaude').mockResolvedValue('test result');
  });
  afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });
  it.each(['generateWeeklySummary', 'detectAnomalies', 'analyzeDifficulty'] as const)('includes the site break in %s without contacting an AI provider', async (method) => {
    await service[method]('2026-09-08', '2026-09-08', 'site-a');
    expect(prisma.breakConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      isActive: true, OR: [{ siteId: null }, { siteId: { in: ['site-a'] } }],
    } }));
    expect(call.mock.calls[0][0]).toMatch(/(?:avgDurationMinutes|duration_minutes|avgMinutes|avgDurationMin)["\s:]+120/);
  });
});
