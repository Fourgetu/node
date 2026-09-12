import { z } from 'zod';

import { REST_API } from '../../api';

export namespace StopSingBoxCommand {
    export const url = REST_API.CORE.STOP_SINGBOX;
    export const ResponseSchema = z.object({
        response: z.object({ isStopped: z.boolean() }),
    });
    export type Response = z.infer<typeof ResponseSchema>;
}
