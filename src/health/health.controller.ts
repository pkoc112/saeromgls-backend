import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: '서비스 liveness 확인' })
  async check() {
    return this.healthService.getLiveness();
  }

  @Get('readiness')
  @ApiOperation({ summary: '서비스 readiness 확인' })
  async readiness() {
    return this.healthService.getReadiness();
  }
}
