import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CoreStateService } from './core-state.service';
import { CoreController } from './core.controller';
import { SingBoxProcessService } from './singbox-process.service';
import { SingBoxStatsService } from './singbox-stats.service';
import { SingBoxService } from './singbox.service';
import { XrayStatsService } from './xray-stats.service';

@Global()
@Module({
    imports: [CqrsModule],
    providers: [
        CoreStateService,
        SingBoxProcessService,
        SingBoxStatsService,
        XrayStatsService,
        SingBoxService,
    ],
    controllers: [CoreController],
    exports: [CoreStateService, SingBoxService, SingBoxStatsService, XrayStatsService],
})
export class CoreModule implements OnModuleDestroy {
    constructor(private readonly singBoxService: SingBoxService) {}

    public async onModuleDestroy(): Promise<void> {
        await this.singBoxService.stop();
    }
}
