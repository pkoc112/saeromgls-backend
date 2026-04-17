import {
  safeDiv, clamp, fix2, resolveTrack, getGrade, scaleBands, readPolicyConfig,
  DEFAULT_PAYOUT_BANDS, VALID_TRACKS, TRACK_MIGRATION,
  MIN_WORKERS, MIN_DAYS_WORKED, WORKING_DAYS,
} from './incentive-utils';

describe('incentive-utils', () => {
  // ──────────────────────────────────────────────
  // safeDiv
  // ──────────────────────────────────────────────
  describe('safeDiv', () => {
    it('정상 나눗셈', () => {
      expect(safeDiv(10, 2)).toBe(5);
      expect(safeDiv(100, 4)).toBe(25);
    });

    it('분모 0 → fallback 반환', () => {
      expect(safeDiv(10, 0)).toBe(0);
      expect(safeDiv(10, 0, -1)).toBe(-1);
    });

    it('분모 음수 → fallback 반환', () => {
      expect(safeDiv(10, -1)).toBe(0);
    });

    it('분자 0 정상', () => {
      expect(safeDiv(0, 5)).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // clamp
  // ──────────────────────────────────────────────
  describe('clamp', () => {
    it('범위 내는 그대로', () => {
      expect(clamp(50, 0, 100)).toBe(50);
    });

    it('min 미만은 min으로', () => {
      expect(clamp(-10, 0, 100)).toBe(0);
      expect(clamp(-0.5, 0, 1)).toBe(0);
    });

    it('max 초과는 max로', () => {
      expect(clamp(150, 0, 100)).toBe(100);
      expect(clamp(1.5, 0, 1)).toBe(1);
    });

    it('경계값 정확', () => {
      expect(clamp(0, 0, 100)).toBe(0);
      expect(clamp(100, 0, 100)).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // fix2
  // ──────────────────────────────────────────────
  describe('fix2', () => {
    it('소수점 2자리 반올림', () => {
      expect(fix2(3.14159)).toBe(3.14);
      expect(fix2(0.005)).toBe(0.01);
      expect(fix2(99.999)).toBe(100);
    });

    it('정수는 그대로', () => {
      expect(fix2(100)).toBe(100);
      expect(fix2(0)).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // resolveTrack — 구 5트랙 → 신 4트랙
  // ──────────────────────────────────────────────
  describe('resolveTrack', () => {
    it('구 5트랙을 신 4트랙으로 매핑', () => {
      expect(resolveTrack('OUTBOUND_RANKED')).toBe('OUTBOUND');
      expect(resolveTrack('INBOUND_SUPPORT')).toBe('INBOUND_DOCK');
      expect(resolveTrack('INSPECTION_GOAL')).toBe('INSPECTION');
      expect(resolveTrack('DOCK_WRAP_GOAL')).toBe('INBOUND_DOCK'); // 상하차→입고 흡수
      expect(resolveTrack('MANAGER_OPS')).toBe('MANAGER');
    });

    it('신 4트랙은 그대로', () => {
      expect(resolveTrack('OUTBOUND')).toBe('OUTBOUND');
      expect(resolveTrack('INBOUND_DOCK')).toBe('INBOUND_DOCK');
      expect(resolveTrack('INSPECTION')).toBe('INSPECTION');
      expect(resolveTrack('MANAGER')).toBe('MANAGER');
    });

    it('알 수 없는 트랙은 그대로 반환', () => {
      expect(resolveTrack('UNKNOWN')).toBe('UNKNOWN');
      expect(resolveTrack('')).toBe('');
    });
  });

  // ──────────────────────────────────────────────
  // getGrade — 밴드 매칭
  // ──────────────────────────────────────────────
  describe('getGrade', () => {
    it('A등급 — 90~100', () => {
      expect(getGrade(100).grade).toBe('A');
      expect(getGrade(95).grade).toBe('A');
      expect(getGrade(90).grade).toBe('A');
      expect(getGrade(100).amount).toBe(500000);
    });

    it('B등급 — 80~89', () => {
      expect(getGrade(89).grade).toBe('B');
      expect(getGrade(85).grade).toBe('B');
      expect(getGrade(80).grade).toBe('B');
      expect(getGrade(85).amount).toBe(400000);
    });

    it('C등급 — 70~79', () => {
      expect(getGrade(79).grade).toBe('C');
      expect(getGrade(70).grade).toBe('C');
      expect(getGrade(75).amount).toBe(300000);
    });

    it('D등급 — 60~69', () => {
      expect(getGrade(69).grade).toBe('D');
      expect(getGrade(60).grade).toBe('D');
      expect(getGrade(65).amount).toBe(150000);
    });

    it('E등급 — 0~59 (지급 없음)', () => {
      expect(getGrade(59).grade).toBe('E');
      expect(getGrade(0).grade).toBe('E');
      expect(getGrade(30).amount).toBe(0);
    });

    it('음수 점수 → E등급 fallback', () => {
      expect(getGrade(-5).grade).toBe('E');
      expect(getGrade(-5).amount).toBe(0);
    });

    it('커스텀 밴드 지원', () => {
      const customBands = [
        { grade: 'S', min: 95, max: 100, amount: 1000000 },
        { grade: 'A', min: 80, max: 94, amount: 500000 },
        { grade: 'B', min: 0, max: 79, amount: 0 },
      ];
      expect(getGrade(96, customBands).grade).toBe('S');
      expect(getGrade(85, customBands).grade).toBe('A');
      expect(getGrade(70, customBands).grade).toBe('B');
    });
  });

  // ──────────────────────────────────────────────
  // scaleBands — baseIncentive 비례 조정
  // ──────────────────────────────────────────────
  describe('scaleBands', () => {
    it('baseIncentive가 기본값과 같으면 원본 반환', () => {
      const result = scaleBands(DEFAULT_PAYOUT_BANDS, 500000);
      expect(result).toEqual(DEFAULT_PAYOUT_BANDS);
    });

    it('baseIncentive 300000 → 60% 비례 축소', () => {
      const result = scaleBands(DEFAULT_PAYOUT_BANDS, 300000);
      expect(result.find((b) => b.grade === 'A')?.amount).toBe(300000);
      expect(result.find((b) => b.grade === 'B')?.amount).toBe(240000); // 400000 * 0.6
      expect(result.find((b) => b.grade === 'C')?.amount).toBe(180000); // 300000 * 0.6
      expect(result.find((b) => b.grade === 'D')?.amount).toBe(90000);  // 150000 * 0.6
      expect(result.find((b) => b.grade === 'E')?.amount).toBe(0);
    });

    it('baseIncentive 1000000 → 200% 비례 확대', () => {
      const result = scaleBands(DEFAULT_PAYOUT_BANDS, 1000000);
      expect(result.find((b) => b.grade === 'A')?.amount).toBe(1000000);
      expect(result.find((b) => b.grade === 'B')?.amount).toBe(800000);
    });

    it('grade 조건(min/max)은 변경하지 않음', () => {
      const result = scaleBands(DEFAULT_PAYOUT_BANDS, 100000);
      result.forEach((b, i) => {
        expect(b.min).toBe(DEFAULT_PAYOUT_BANDS[i].min);
        expect(b.max).toBe(DEFAULT_PAYOUT_BANDS[i].max);
      });
    });

    it('A 밴드가 0인 이상 케이스는 원본 반환 (divide by zero 방지)', () => {
      const zeroBands = [
        { grade: 'A', min: 90, max: 100, amount: 0 },
        { grade: 'B', min: 0, max: 89, amount: 0 },
      ];
      const result = scaleBands(zeroBands, 500000);
      expect(result).toEqual(zeroBands);
    });
  });

  // ──────────────────────────────────────────────
  // readPolicyConfig — 정책 details 오버라이드
  // ──────────────────────────────────────────────
  describe('readPolicyConfig', () => {
    it('빈 details → 모두 기본값', () => {
      const cfg = readPolicyConfig(null);
      expect(cfg.workingDays).toBe(WORKING_DAYS);
      expect(cfg.minWorkers).toBe(MIN_WORKERS);
      expect(cfg.minDaysWorked).toBe(MIN_DAYS_WORKED);
      expect(cfg.payoutBands).toEqual(DEFAULT_PAYOUT_BANDS);
    });

    it('workingDays 오버라이드 (주 6일제 = 26일)', () => {
      const cfg = readPolicyConfig({ workingDays: 26 });
      expect(cfg.workingDays).toBe(26);
    });

    it('minWorkers 오버라이드 (소규모 사업장 = 2명)', () => {
      const cfg = readPolicyConfig({ minWorkers: 2 });
      expect(cfg.minWorkers).toBe(2);
    });

    it('payoutBands 오버라이드', () => {
      const customBands = [
        { grade: 'S', min: 95, max: 100, amount: 1000000 },
      ];
      const cfg = readPolicyConfig({ payoutBands: customBands });
      expect(cfg.payoutBands).toEqual(customBands);
    });

    it('잘못된 타입은 무시하고 기본값 사용', () => {
      const cfg = readPolicyConfig({ workingDays: 'invalid', minWorkers: -1 });
      expect(cfg.workingDays).toBe(WORKING_DAYS);
      expect(cfg.minWorkers).toBe(MIN_WORKERS);
    });

    it('undefined/primitive 입력 방어', () => {
      expect(readPolicyConfig(undefined).workingDays).toBe(WORKING_DAYS);
      expect(readPolicyConfig('string' as any).workingDays).toBe(WORKING_DAYS);
      expect(readPolicyConfig(123 as any).workingDays).toBe(WORKING_DAYS);
    });
  });

  // ──────────────────────────────────────────────
  // 상수 유효성
  // ──────────────────────────────────────────────
  describe('상수', () => {
    it('VALID_TRACKS는 정확히 4개', () => {
      expect(VALID_TRACKS.length).toBe(4);
      expect(VALID_TRACKS).toContain('OUTBOUND');
      expect(VALID_TRACKS).toContain('INBOUND_DOCK');
      expect(VALID_TRACKS).toContain('INSPECTION');
      expect(VALID_TRACKS).toContain('MANAGER');
    });

    it('TRACK_MIGRATION의 모든 값은 VALID_TRACKS에 포함', () => {
      for (const newTrack of Object.values(TRACK_MIGRATION)) {
        expect(VALID_TRACKS).toContain(newTrack as any);
      }
    });

    it('DEFAULT_PAYOUT_BANDS는 A~E 순서대로 감소', () => {
      expect(DEFAULT_PAYOUT_BANDS.length).toBe(5);
      expect(DEFAULT_PAYOUT_BANDS[0].grade).toBe('A');
      expect(DEFAULT_PAYOUT_BANDS[4].grade).toBe('E');
      for (let i = 0; i < DEFAULT_PAYOUT_BANDS.length - 1; i++) {
        expect(DEFAULT_PAYOUT_BANDS[i].amount).toBeGreaterThanOrEqual(DEFAULT_PAYOUT_BANDS[i + 1].amount);
      }
    });

    it('DEFAULT_PAYOUT_BANDS 점수 범위가 겹치지 않음', () => {
      const sorted = [...DEFAULT_PAYOUT_BANDS].sort((a, b) => a.min - b.min);
      for (let i = 0; i < sorted.length - 1; i++) {
        expect(sorted[i].max).toBeLessThan(sorted[i + 1].min);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 통합 시나리오 — 실제 점수 → 지급액 흐름
  // ──────────────────────────────────────────────
  describe('통합 시나리오: 점수 → 지급액', () => {
    it('만점 작업자 + 기본 baseIncentive → 500,000원', () => {
      const cfg = readPolicyConfig(null);
      const { amount } = getGrade(100, cfg.payoutBands);
      expect(amount).toBe(500000);
    });

    it('85점 작업자 + baseIncentive 300,000 → 240,000원', () => {
      const cfg = readPolicyConfig(null);
      const scaled = scaleBands(cfg.payoutBands, 300000);
      const { grade, amount } = getGrade(85, scaled);
      expect(grade).toBe('B');
      expect(amount).toBe(240000); // 400000 * (300000/500000)
    });

    it('미달 작업자(55점) → E등급 0원', () => {
      const { grade, amount } = getGrade(55);
      expect(grade).toBe('E');
      expect(amount).toBe(0);
    });

    it('클램프된 점수는 100을 넘지 않음', () => {
      const score = clamp(fix2(105.7), 0, 100);
      expect(score).toBe(100);
      expect(getGrade(score).grade).toBe('A');
    });
  });
});
