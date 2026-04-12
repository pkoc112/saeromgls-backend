import { SetMetadata } from '@nestjs/common';

export const FEATURE_KEY = 'requiredFeature';

/**
 * 엔드포인트에 필요한 플랜 기능 코드를 지정하는 데코레이터
 *
 * 사용법:
 *   @Feature('AI_INSIGHT')
 *   @Feature('ADVANCED_REPORT')
 */
export const Feature = (featureCode: string) =>
  SetMetadata(FEATURE_KEY, featureCode);
