import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

const execFileAsync = promisify(execFile);

export interface ISingBoxProcessStatus {
    up: boolean;
    pid: number | null;
    raw: string;
}

@Injectable()
export class SingBoxProcessService {
    private readonly logger = new Logger(SingBoxProcessService.name);
    private readonly serviceDir = process.env.SINGBOX_S6_SERVICE_DIR ?? '/run/service/sing-box';
    private readonly controlFifo = `${this.serviceDir}/supervise/control`;

    private static readonly S6_SVC = '/command/s6-svc';
    private static readonly S6_SVSTAT = '/command/s6-svstat';
    private static readonly DOWN_TIMEOUT_MS = 5_000;
    private static readonly UP_TIMEOUT_MS = 10_000;

    public isControlAvailable(): boolean {
        return existsSync(this.controlFifo);
    }

    public async stop(): Promise<void> {
        if (!this.isControlAvailable()) return;

        await execFileAsync(SingBoxProcessService.S6_SVC, [
            '-wd',
            '-T',
            String(SingBoxProcessService.DOWN_TIMEOUT_MS),
            '-d',
            this.serviceDir,
        ]);
    }

    public async restart(): Promise<void> {
        if (!this.isControlAvailable()) {
            throw new Error('s6 sing-box control socket not found');
        }

        await this.stop();
        await execFileAsync(SingBoxProcessService.S6_SVC, [
            '-wu',
            '-T',
            String(SingBoxProcessService.UP_TIMEOUT_MS),
            '-o',
            this.serviceDir,
        ]);
    }

    public async getStatus(): Promise<ISingBoxProcessStatus> {
        try {
            const { stdout } = await execFileAsync(SingBoxProcessService.S6_SVSTAT, [
                '-o',
                'up,pid',
                this.serviceDir,
            ]);
            const raw = stdout.trim();
            const [up, pid] = raw.split(/\s+/);
            const parsedPid = Number(pid);

            return {
                up: up === 'true',
                pid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
                raw,
            };
        } catch (error) {
            this.logger.warn(`Failed to read sing-box s6 status: ${error}`);
            return { up: false, pid: null, raw: '' };
        }
    }
}
