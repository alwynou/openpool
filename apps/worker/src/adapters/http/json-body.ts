const MAX_JSON_BODY_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/iu;
const DECIMAL_BYTES = /^(?:0|[1-9]\d*)$/u;

/**
 * Reads a small, uncompressed JSON request without trusting Content-Length.
 * Returning undefined keeps route-specific validation errors stable.
 */
export async function readJsonBody(
  request: Request,
): Promise<unknown | undefined> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) {
    return undefined;
  }

  const contentEncoding = request.headers.get('content-encoding');
  if (
    contentEncoding !== null &&
    contentEncoding.trim().toLowerCase() !== 'identity'
  ) {
    return undefined;
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!DECIMAL_BYTES.test(declaredLength)) return undefined;
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_JSON_BODY_BYTES) {
      return undefined;
    }
  }

  if (request.body === null) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
