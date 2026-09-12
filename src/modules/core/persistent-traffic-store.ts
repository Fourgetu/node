import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class PersistentTrafficStore {
    public readonly values = new Map<string, number>();

    constructor(private readonly path: string) {
        this.load();
    }

    public async save(): Promise<void> {
        if (this.values.size === 0) {
            await rm(this.path, { force: true });
            return;
        }

        await mkdir(dirname(this.path), { recursive: true });
        const temporaryPath = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(Array.from(this.values)), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await rename(temporaryPath, this.path);
    }

    private load(): void {
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
            if (!Array.isArray(parsed)) return;
            for (const entry of parsed) {
                if (
                    Array.isArray(entry) &&
                    entry.length === 2 &&
                    typeof entry[0] === 'string' &&
                    typeof entry[1] === 'number' &&
                    Number.isFinite(entry[1]) &&
                    entry[1] >= 0
                ) {
                    this.values.set(entry[0], entry[1]);
                }
            }
        } catch {
            // Missing or corrupt state fails closed to an empty accumulator.
        }
    }
}
