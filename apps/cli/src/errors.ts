import { OpenPoolApiError, OpenPoolProtocolError, OpenPoolTransferError } from '@openpool/sdk';

export class CliFailure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CliFailure';
  }
}

export function safeError(error: unknown): {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
} {
  if (error instanceof CliFailure) return { code: error.code, message: error.message };
  if (error instanceof OpenPoolApiError) {
    return {
      code: /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code) ? error.code : 'API_ERROR',
      message: 'OpenPool rejected the request. No automatic retry was attempted.',
      status: error.status,
      ...(error.requestId !== null && /^[A-Za-z0-9._:-]{1,128}$/u.test(error.requestId)
        ? { requestId: error.requestId } : {}),
    };
  }
  if (error instanceof OpenPoolTransferError) {
    return { code: 'TRANSFER_FAILED', message: 'The provider rejected the direct transfer.', status: error.status };
  }
  if (error instanceof OpenPoolProtocolError) {
    return { code: 'PROTOCOL_ERROR', message: 'OpenPool returned an invalid response.', status: error.status };
  }
  // Fetch, filesystem and upstream messages can contain URLs, secrets or file paths.
  return { code: 'OPERATION_FAILED', message: 'The operation failed. No automatic retry was attempted.' };
}
