import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';

import { HttpExceptionFilter } from '@common/exception';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';
import { errorHandler } from '@common/helpers';
import { CORE_CONTROLLER, CORE_ROUTES } from '@libs/contracts/api/controllers/core';
import { StopSingBoxCommand } from '@libs/contracts/commands';

import { SingBoxService } from './singbox.service';

@UseFilters(HttpExceptionFilter)
@UseGuards(JwtDefaultGuard)
@Controller(CORE_CONTROLLER)
export class CoreController {
    constructor(private readonly singBoxService: SingBoxService) {}

    @Get(CORE_ROUTES.STOP_SINGBOX)
    public async stopSingBox(): Promise<StopSingBoxCommand.Response> {
        const result = await this.singBoxService.stop();
        const response = errorHandler(result);
        return { response: { isStopped: response.isStopped } };
    }
}
