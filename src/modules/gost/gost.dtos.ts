import { createZodDto } from 'nestjs-zod';

import { GetGostHealthCommand, SyncGostForwardsCommand } from '@libs/contracts/commands';

export class SyncGostForwardsRequestDto extends createZodDto(
    SyncGostForwardsCommand.RequestSchema,
) {}

export class SyncGostForwardsResponseDto extends createZodDto(
    SyncGostForwardsCommand.ResponseSchema,
) {}

export class GetGostHealthResponseDto extends createZodDto(GetGostHealthCommand.ResponseSchema) {}
