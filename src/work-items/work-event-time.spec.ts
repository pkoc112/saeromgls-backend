import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { resolveWorkEventTime } from './work-event-time';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { EndWorkItemDto } from './dto/end-work-item.dto';
import { PauseWorkItemDto } from './dto/pause-work-item.dto';
import { WorkEventDto } from './dto/work-event.dto';

describe('offline work event time', () => {
  const now = new Date('2026-09-08T10:00:00Z');
  const work = { startedAt: new Date('2026-09-08T01:00:00Z'), notes: JSON.stringify({ pauseHistory: [
    { pausedAt: '2026-09-08T01:20:00Z', resumedAt: '2026-09-08T01:30:00Z' },
  ] }) };
  it('keeps occurrence time instead of upload time', () => {
    expect(resolveWorkEventTime('2026-09-08T02:00:00Z', work, now).toISOString()).toBe('2026-09-08T02:00:00.000Z');
  });
  it.each(['invalid', '2026-09-08T02:00:00', '2026-09-08T01:25:00Z', '2026-09-08T11:00:00Z', '2026-01-01T00:00:00Z'])(
    'rejects malformed, reversed or out of range time: %s', (time) => {
      expect(() => resolveWorkEventTime(time, work, now)).toThrow(BadRequestException);
    },
  );
  it('preserves legacy clients that omit time and accept equal timestamps', () => {
    expect(resolveWorkEventTime(undefined, work, now)).toEqual(now);
    expect(resolveWorkEventTime('2026-09-08T01:30:00Z', work, now).getTime()).toBe(Date.parse('2026-09-08T01:30:00Z'));
  });
  const uuid = '00000000-0000-4000-8000-000000000001';
  it.each([CreateWorkItemDto, EndWorkItemDto, PauseWorkItemDto, WorkEventDto])('keeps inherited event fields through the whitelist: %p', async (Dto) => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const dto = await pipe.transform({ startedByWorkerId: uuid, classificationId: uuid, endedByWorkerId: uuid,
      pausedByWorkerId: uuid, eventId: uuid, occurredAt: '2026-09-08T01:00:00Z' }, { type: 'body', metatype: Dto });
    expect(dto.eventId).toBe(uuid); expect(dto.occurredAt).toBe('2026-09-08T01:00:00Z');
  });
});
