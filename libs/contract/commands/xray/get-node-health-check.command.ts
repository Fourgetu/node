import { z } from 'zod';

import { REST_API } from '../../api';

export namespace GetNodeHealthCheckCommand {
    export const url = REST_API.XRAY.NODE_HEALTH_CHECK;

    export const ResponseSchema = z.object({
        response: z.object({
            isAlive: z.boolean(),
            xrayInternalStatusCached: z.boolean(),
            xrayVersion: z.string().nullable(),
            nodeVersion: z.string(),
            cores: z
                .object({
                    xray: z.object({
                        online: z.boolean(),
                        version: z.string().nullable(),
                    }),
                    singbox: z.object({
                        online: z.boolean(),
                        version: z.string().nullable(),
                    }),
                    gost: z.object({
                        online: z.boolean(),
                        version: z.string().nullable(),
                        installed: z.boolean(),
                        services: z.number().int().nonnegative(),
                    }),
                })
                .optional(),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
