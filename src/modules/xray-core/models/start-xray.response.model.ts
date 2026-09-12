import { CORE_TYPE, TCoreType } from '@libs/contracts/constants';
import { TNodeSystem } from '@libs/contracts/models';

interface INodeInformation {
    version: string | null;
}

export class StartXrayResponseModel {
    public isStarted: boolean;
    public version: null | string;
    public error: null | string;
    public nodeInformation: INodeInformation;
    public system: TNodeSystem;
    public coreType: TCoreType;

    constructor(
        isStarted: boolean,
        version: null | string,
        error: null | string,
        nodeInformation: INodeInformation,
        system: TNodeSystem,
        coreType: TCoreType = CORE_TYPE.XRAY,
    ) {
        this.isStarted = isStarted;
        this.version = version;
        this.error = error;
        this.nodeInformation = nodeInformation;
        this.system = system;
        this.coreType = coreType;
    }
}
