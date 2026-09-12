import { Module } from '@nestjs/common';

import { GostForwardManager } from './gost-forward-manager.service';
import { GostController } from './gost.controller';
import { GostService } from './gost.service';
import { PortHoppingManager } from './port-hopping-manager.service';

@Module({
    controllers: [GostController],
    providers: [GostForwardManager, GostService, PortHoppingManager],
    exports: [GostForwardManager, GostService],
})
export class GostModule {}
