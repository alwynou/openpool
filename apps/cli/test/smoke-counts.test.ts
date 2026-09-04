import { describe, expect, it } from 'vitest';
import { checkedObservations } from '../src/smoke/run.js';
import type { CommandResult } from '../src/smoke/child.js';
import type { Fault } from '../src/smoke/observer.js';

function result(controlRequests: number, puts: number, gets: number): CommandResult {
  return { code: 0, output: null, events: [], elapsedMs: 1, observations: [{
    type: 'measurement', startRssBytes: 10, peakRssBytes: 20, controlRequests, puts, gets, maxControlBodyBytes: 0,
  }] };
}

describe('smoke consumes transport evidence', () => {
  it.each([
    ['upload', 'none', 2, 1, 0], ['retry', 'none', 3, 1, 0], ['download', 'none', 2, 0, 1],
    ['upload-status', 'none', 1, 0, 0], ['complete', 'none', 1, 0, 0], ['delete', 'none', 1, 0, 0],
    ['upload', 'upload-interrupt', 1, 1, 0], ['download', 'download-interrupt', 2, 0, 1],
  ] as const)('requires exact counts for %s / %s', (command, fault, control, puts, gets) => {
    const valid = result(control, puts, gets);
    expect(checkedObservations(valid, command, fault as Fault)).toEqual(valid.observations);
    expect(() => checkedObservations(result(control + 1, puts, gets), command, fault as Fault)).toThrow('request counts');
    expect(() => checkedObservations(result(control, puts + 1, gets), command, fault as Fault)).toThrow('request counts');
    expect(() => checkedObservations(result(control, puts, gets + 1), command, fault as Fault)).toThrow('request counts');
  });

  it('requires zero network requests on OUTPUT_EXISTS and does not treat other errors as that exemption', () => {
    const blocked = { ...result(0, 0, 0), code: 1, events: [{ error: { code: 'OUTPUT_EXISTS' } }] };
    expect(checkedObservations(blocked, 'download', 'none')).toEqual(blocked.observations);
    expect(() => checkedObservations({ ...blocked, observations: result(1, 0, 0).observations }, 'download', 'none')).toThrow('request counts');
    expect(() => checkedObservations({ ...blocked, events: [{ error: { code: 'FORBIDDEN' } }] }, 'download', 'none')).toThrow('request counts');
  });

  it('fails when the measurement is absent or duplicated', () => {
    const value = result(2, 1, 0);
    expect(() => checkedObservations({ ...value, observations: [] }, 'upload', 'none')).toThrow('observations are missing');
    expect(() => checkedObservations({ ...value, observations: [...value.observations, ...value.observations] }, 'upload', 'none')).toThrow('observations are missing');
  });

  it('rejects unsafe fields before returning data for a report', () => {
    const value = result(2, 1, 0);
    const measurement = value.observations[0];
    if (measurement?.type !== 'measurement') throw new Error('Expected test measurement');
    const unsafe = { ...measurement, url: 'https://provider.example/?X-Amz-Signature=secret' };
    expect(() => checkedObservations({ ...value, observations: [unsafe] }, 'upload', 'none')).toThrow('invalid observation data');
  });
});
