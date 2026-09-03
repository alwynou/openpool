export const OBSERVATION_INVALID_MESSAGE = 'Smoke observer emitted invalid observation data.';

export interface Measurement {
  type: 'measurement'; startRssBytes: number; peakRssBytes: number;
  controlRequests: number; maxControlBodyBytes: number; puts: number; gets: number;
}
export interface Interruption { type: 'interruption'; direction: 'upload' | 'download'; bytes: number; totalBytes: number; }
export type Observation = Measurement | Interruption | { type: 'complete-loss' };

function invalid(): never {
  throw new Error(OBSERVATION_INVALID_MESSAGE);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

/** Parse and copy observer IPC data, rejecting unknown fields and unsafe values. */
export function parseObservation(value: unknown): Observation {
  try {
    const item = record(value);
    if (item.type === 'complete-loss') {
      exactKeys(item, ['type']);
      return { type: 'complete-loss' };
    }
    if (item.type === 'measurement') {
      exactKeys(item, ['type', 'startRssBytes', 'peakRssBytes', 'controlRequests', 'maxControlBodyBytes', 'puts', 'gets']);
      const startRssBytes = safeInteger(item.startRssBytes);
      const peakRssBytes = safeInteger(item.peakRssBytes);
      const controlRequests = safeInteger(item.controlRequests);
      const maxControlBodyBytes = safeInteger(item.maxControlBodyBytes);
      const puts = safeInteger(item.puts);
      const gets = safeInteger(item.gets);
      if (startRssBytes === 0 || peakRssBytes < startRssBytes || maxControlBodyBytes > 65_536) invalid();
      return { type: 'measurement', startRssBytes, peakRssBytes, controlRequests, maxControlBodyBytes, puts, gets };
    }
    if (item.type === 'interruption') {
      exactKeys(item, ['type', 'direction', 'bytes', 'totalBytes']);
      const direction = item.direction;
      if (direction !== 'upload' && direction !== 'download') invalid();
      const bytes = safeInteger(item.bytes);
      const totalBytes = safeInteger(item.totalBytes);
      if (bytes === 0 || totalBytes === 0 || bytes >= totalBytes) invalid();
      return { type: 'interruption', direction, bytes, totalBytes };
    }
    invalid();
  } catch (error) {
    if (error instanceof Error && error.message === OBSERVATION_INVALID_MESSAGE) throw error;
    invalid();
  }
}
