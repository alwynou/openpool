export class OpenPoolApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'OpenPoolApiError';
  }
}

export class OpenPoolProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpenPoolProtocolError';
  }
}

export type OpenPoolTransferOperation = 'UPLOAD' | 'DOWNLOAD';

export class OpenPoolTransferError extends Error {
  constructor(
    readonly operation: OpenPoolTransferOperation,
    readonly status: number,
  ) {
    super(`The provider rejected the direct ${operation.toLowerCase()}.`);
    this.name = 'OpenPoolTransferError';
  }
}
