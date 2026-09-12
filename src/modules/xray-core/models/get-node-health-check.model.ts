import { ICoreRuntimeState } from '../../core/core-state.service';

export class GetNodeHealthCheckResponseModel {
    public isAlive: boolean;
    public xrayInternalStatusCached: boolean;
    public xrayVersion: null | string;
    public nodeVersion: string;
    public cores: {
        xray: ICoreRuntimeState;
        singbox: ICoreRuntimeState;
        gost: ICoreRuntimeState & { installed: boolean; services: number };
    };
    constructor(
        isAlive: boolean,
        xrayInternalStatusCached: boolean,
        xrayVersion: null | string,
        nodeVersion: string,
        cores: {
            xray: ICoreRuntimeState;
            singbox: ICoreRuntimeState;
            gost: ICoreRuntimeState & { installed: boolean; services: number };
        },
    ) {
        this.isAlive = isAlive;
        this.xrayInternalStatusCached = xrayInternalStatusCached;
        this.xrayVersion = xrayVersion;
        this.nodeVersion = nodeVersion;
        this.cores = cores;
    }
}
