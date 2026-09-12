export const CORE_TYPE = {
    XRAY: 'xray',
    SINGBOX: 'singbox',
} as const;

export type TCoreType = (typeof CORE_TYPE)[keyof typeof CORE_TYPE];
