import { randomBytes } from 'node:crypto';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export const newRequestId = (): string => `req_${hex(8)}`;
export const newCompletionId = (): string => `chatcmpl-${hex(12)}`;
export const newToolCallId = (): string => `call_${hex(8)}`;
