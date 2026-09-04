import { describe, expect, it } from 'vitest';

import { OBSERVATION_INVALID_MESSAGE, parseObservation } from '../src/smoke/observations.js';

const measurement = {
  type: 'measurement' as const, startRssBytes: 100, peakRssBytes: 200,
  controlRequests: 4, maxControlBodyBytes: 512, puts: 1, gets: 2,
};

function expectInvalid(value: unknown): void {
  expect(() => parseObservation(value)).toThrowError(OBSERVATION_INVALID_MESSAGE);
}

describe('parseObservation', () => {
  it('parses and copies valid measurements without retaining unknown fields', () => {
    const input = { ...measurement };
    expect(parseObservation(input)).toEqual(measurement);
    expectInvalid({ ...measurement, inherited: 'not accepted' });
  });

  it('parses valid interruptions and completion-loss observations', () => {
    expect(parseObservation({ type: 'interruption', direction: 'upload', bytes: 1, totalBytes: 50_000_000 })).toEqual({
      type: 'interruption', direction: 'upload', bytes: 1, totalBytes: 50_000_000,
    });
    expect(parseObservation({ type: 'interruption', direction: 'download', bytes: 49, totalBytes: 50 })).toEqual({
      type: 'interruption', direction: 'download', bytes: 49, totalBytes: 50,
    });
    expect(parseObservation({ type: 'complete-loss' })).toEqual({ type: 'complete-loss' });
  });

  it.each([
    null, undefined, [], 'measurement', { type: 'unknown' }, { type: 'complete-loss', secret: 'token' },
  ])('rejects non-observation values and unknown/extra fields: %j', (value) => {
    expectInvalid(value);
  });

  it.each([
    { ...measurement, startRssBytes: 0 },
    { ...measurement, startRssBytes: -1 },
    { ...measurement, peakRssBytes: 99 },
    { ...measurement, peakRssBytes: Number.POSITIVE_INFINITY },
    { ...measurement, controlRequests: 1.5 },
    { ...measurement, maxControlBodyBytes: 65_537 },
    { ...measurement, maxControlBodyBytes: -1 },
    { ...measurement, extra: 'secret' },
  ])('rejects unsafe or malformed measurements: %j', (value) => {
    expectInvalid(value);
  });

  it.each([
    { type: 'interruption', direction: 'upload', bytes: 0, totalBytes: 10 },
    { type: 'interruption', direction: 'upload', bytes: 10, totalBytes: 10 },
    { type: 'interruption', direction: 'upload', bytes: 11, totalBytes: 10 },
    { type: 'interruption', direction: 'sideways', bytes: 1, totalBytes: 10 },
    { type: 'interruption', direction: 'download', bytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER },
    { type: 'interruption', direction: 'download', bytes: 1, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'interruption', direction: 'download', bytes: 1, totalBytes: 10, secret: 'signed-url' },
  ])('rejects unsafe or malformed interruptions: %j', (value) => {
    expectInvalid(value);
  });

  it('uses a constant safe error without echoing invalid payloads', () => {
    const secret = 'https://provider.example/upload?X-Amz-Signature=secret-token';
    let thrown: unknown;
    try { parseObservation({ type: 'interruption', direction: 'upload', bytes: 0, totalBytes: 1, secret }); }
    catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ message: OBSERVATION_INVALID_MESSAGE });
    expect(String(thrown)).not.toContain(secret);
  });
});
