import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common';

import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';
import { errorHandler } from '@common/helpers/error-handler.helper';
import { GOST_CONTROLLER, GOST_ROUTES } from '@libs/contracts/api/controllers/gost';

import {
    GetGostHealthResponseDto,
    SyncGostForwardsRequestDto,
    SyncGostForwardsResponseDto,
} from './gost.dtos';
import { GostService } from './gost.service';

@UseFilters(HttpExceptionFilter)
@UseGuards(JwtDefaultGuard)
@Controller(GOST_CONTROLLER)
export class GostController {
    constructor(private readonly gostService: GostService) {}

    @Post(GOST_ROUTES.SYNC_FORWARDS)
    public async syncForwards(
        @Body() body: SyncGostForwardsRequestDto,
    ): Promise<SyncGostForwardsResponseDto> {
        return { response: errorHandler(await this.gostService.syncForwards(body)) };
    }

    @Get(GOST_ROUTES.HEALTH)
    public async health(): Promise<GetGostHealthResponseDto> {
        return { response: errorHandler(await this.gostService.health()) };
    }
}
