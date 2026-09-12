import { z } from 'zod';

import { REST_API } from '../../api';

export namespace GetGostHealthCommand {
    export const url = REST_API.GOST.HEALTH;

    export const ResponseSchema = z.object({
        response: z.object({
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
