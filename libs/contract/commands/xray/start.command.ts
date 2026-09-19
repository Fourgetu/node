import { z } from 'zod';

import { REST_API } from '../../api';
import { CORE_TYPE } from '../../constants';
import { NodeMetadataSchema, NodeSystemSchema } from '../../models';

export namespace StartXrayCommand {
    export const url = REST_API.XRAY.START;
    export const RequestSchema = z.object({
        coreType: z.enum([CORE_TYPE.XRAY, CORE_TYPE.SINGBOX]).default(CORE_TYPE.XRAY),
        internals: z.object({
            metadata: NodeMetadataSchema.optional(),
            integrations: z.record(z.string(), z.unknown()).optional(),
            forceRestart: z.boolean().default(false),
            hashes: z.object({
                emptyConfig: z.string(),
                inbounds: z.array(
                    z.object({
                        usersCount: z.number(),
                        hash: z.string(),
                        tag: z.string(),
                    }),
                ),
            }),
            certificates: z
                .array(
                    z.object({
                        id: z.string().min(1),
                        hash: z.string().regex(/^[a-f0-9]{64}$/i),
                        certificate: z.string().min(1),
                        privateKey: z.string().min(1),
                    }),
                )
                .optional(),
        }),
        xrayConfig: z.record(z.string(), z.unknown()),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            isStarted: z.boolean(),
            coreType: z.enum([CORE_TYPE.XRAY, CORE_TYPE.SINGBOX]).optional(),
            version: z.string().nullable(),
            error: z.string().nullable(),
            nodeInformation: z.object({
                version: z.string().nullable(),
            }),
            system: NodeSystemSchema,
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
