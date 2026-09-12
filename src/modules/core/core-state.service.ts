import { Injectable } from '@nestjs/common';

import { CORE_TYPE, TCoreType } from '@libs/contracts/constants';

export interface ICoreRuntimeState {
    online: boolean;
    version: string | null;
}

@Injectable()
export class CoreStateService {
    private readonly states = new Map<TCoreType, ICoreRuntimeState>([
        [CORE_TYPE.XRAY, { online: false, version: null }],
        [CORE_TYPE.SINGBOX, { online: false, version: null }],
    ]);

    public setOnline(coreType: TCoreType, version: string | null): void {
        this.states.set(coreType, { online: true, version });
    }

    public setOffline(coreType: TCoreType): void {
        const current = this.getState(coreType);
        this.states.set(coreType, { ...current, online: false });
    }

    public getState(coreType: TCoreType): ICoreRuntimeState {
        return this.states.get(coreType) ?? { online: false, version: null };
    }

    public isOnline(coreType: TCoreType): boolean {
        return this.getState(coreType).online;
    }

    public getAll(): { xray: ICoreRuntimeState; singbox: ICoreRuntimeState } {
        return {
            xray: this.getState(CORE_TYPE.XRAY),
            singbox: this.getState(CORE_TYPE.SINGBOX),
        };
    }
}
