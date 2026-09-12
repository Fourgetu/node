import { z } from 'zod';

import { REST_API } from '../../api';

const PortSchema = z.number().int().min(1).max(65535);
const BytesPerSecondSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export namespace SyncGostForwardsCommand {
    export const url = REST_API.GOST.SYNC_FORWARDS;

    export const RequestSchema = z.object({
        forwards: z.array(
            z.object({
                id: z.uuid(),
                externalPort: PortSchema,
                internalAddress: z.union([z.literal('127.0.0.1'), z.literal('::1')]),
                internalPort: PortSchema,
                network: z.enum(['tcp', 'udp']),
                downloadBytesPerSecond: BytesPerSecondSchema,
                uploadBytesPerSecond: BytesPerSecondSchema,
                enabled: z.boolean(),
                hopStartPort: PortSchema.optional(),
                hopEndPort: PortSchema.optional(),
                hopIntervalSeconds: z.number().int().min(1).max(86400).optional(),
            }),
        ),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            applied: z.boolean(),
            running: z.boolean(),
            installed: z.boolean(),
            gostVersion: z.string().nullable(),
            services: z.number().int().nonnegative(),
            configPath: z.string(),
            error: z.string().nullable(),
            portHopping: z.object({
                mode: z.enum(['disabled', 'nftables']),
                available: z.boolean(),
                applied: z.boolean(),
                requiresNetAdmin: z.literal(true),
                rules: z.number().int().nonnegative(),
                error: z.string().nullable(),
            }),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
