import { Injectable } from '@nestjs/common';

import { GetGostHealthCommand, SyncGostForwardsCommand } from '@libs/contracts/commands';

import { GostForwardManager } from './gost-forward-manager.service';

@Injectable()
export class GostService {
    constructor(private readonly manager: GostForwardManager) {}

    public syncForwards(request: SyncGostForwardsCommand.Request) {
        return this.manager.syncForwards(request);
    }

    public health() {
        return this.manager.health() as Promise<
            import('@common/types').TResult<GetGostHealthCommand.Response['response']>
        >;
    }
}
