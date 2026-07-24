/**
 * ipc-contract.test.ts — the shared IPC contract's structural invariants and a
 * round-trip through the pure request-handler table (no Electron).
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockEngine } from '../../engine/dist/mock/mock-engine.js';
import { EngineService } from '../src/main/engine-service.js';
import { createRequestHandlers } from '../src/main/handlers.js';
import { EVT, REQ } from '../src/shared/ipc.js';
import { formatPlanSummary } from '../src/renderer/plan-format.js';
import { cannedMediaInfo, cannedPlan } from '../../engine/dist/mock/mock-engine.js';

describe('IPC contract shape', () => {
  it('has unique request + event channel names with no cross-collisions', () => {
    const reqVals = Object.values(REQ);
    const evtVals = Object.values(EVT);
    expect(new Set(reqVals).size).toBe(reqVals.length);
    expect(new Set(evtVals).size).toBe(evtVals.length);
    expect(new Set([...reqVals, ...evtVals]).size).toBe(reqVals.length + evtVals.length);
  });

  it('handler table covers exactly the request channels', () => {
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});
    const handlers = createRequestHandlers(service, { openVideoDialog: async () => null });
    expect(new Set(Object.keys(handlers))).toEqual(new Set(Object.values(REQ)));
  });

  it('round-trips probe + dialog + getMode + getStatus through the handlers', async () => {
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});
    const openVideoDialog = vi.fn(async () => '/picked.mkv');
    const handlers = createRequestHandlers(service, { openVideoDialog });

    expect(await handlers[REQ.openVideoDialog](undefined)).toBe('/picked.mkv');
    expect(openVideoDialog).toHaveBeenCalledOnce();

    const media = await handlers[REQ.probe]({ file: '/x.mkv' });
    expect((media as { container: string }).container).toBe('mkv');

    expect(await handlers[REQ.getMode](undefined)).toEqual({ mock: true });
    expect(await handlers[REQ.getStatus](undefined)).toBeNull();
  });

  it('rescanDevices routes through its handler and returns a device snapshot array', async () => {
    // The re-query itself is an engine concern (tested in discovery-mdns.test.ts);
    // here we only assert the channel exists in the table and returns the list
    // shape the renderer feeds into `store.setDevices`.
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});
    const handlers = createRequestHandlers(service, { openVideoDialog: async () => null });
    const devices = await handlers[REQ.rescanDevices](undefined);
    expect(Array.isArray(devices)).toBe(true);
  });

  it('routes getThumbnail through the injected provider, and defaults to null', async () => {
    const service = new EngineService(createMockEngine(), { mock: true }, () => {});

    // Injected provider: the handler forwards the request and returns its result.
    const getThumbnail = vi.fn(async () => 'data:image/jpeg;base64,AAAA');
    const withProvider = createRequestHandlers(service, {
      openVideoDialog: async () => null,
      getThumbnail,
    });
    const req = { file: '/x.mkv', variant: 'backdrop' as const };
    expect(await withProvider[REQ.getThumbnail](req)).toBe('data:image/jpeg;base64,AAAA');
    expect(getThumbnail).toHaveBeenCalledWith(req);

    // A thrown provider is contained as null, never a rejection.
    const throwing = createRequestHandlers(service, {
      openVideoDialog: async () => null,
      getThumbnail: async () => {
        throw new Error('ffmpeg exploded');
      },
    });
    expect(await throwing[REQ.getThumbnail](req)).toBeNull();

    // No provider injected (unit-test default): the handler still exists and
    // resolves null rather than being absent from the table.
    const withoutProvider = createRequestHandlers(service, { openVideoDialog: async () => null });
    expect(await withoutProvider[REQ.getThumbnail](req)).toBeNull();
  });

  it('pull-on-boot getMode surfaces the full mode, including the fallback reason', async () => {
    // The renderer pulls the mode on boot (REQ.getMode) and drives the fallback
    // banner off `reason` — so the reason must survive the request round-trip,
    // not just `mock`.
    const mode = { mock: true, reason: 'real engine unavailable — boom' };
    const service = new EngineService(createMockEngine(), mode, () => {});
    const handlers = createRequestHandlers(service, { openVideoDialog: async () => null });

    expect(await handlers[REQ.getMode](undefined)).toEqual(mode);
  });
});

describe('plan summary formatting', () => {
  it('renders a tier-tagged summary for the canned plan', () => {
    const media = cannedMediaInfo();
    const plan = cannedPlan(media);
    const summary = formatPlanSummary(plan, media);
    expect(summary.tier).toBe('video-transcode');
    expect(summary.tierLabel).toBe('Transcode video');
    expect(summary.text).toContain('MKV → HLS/fMP4');
    expect(summary.text).toContain('video → H.264 1080p');
    expect(summary.text).toContain('audio copy E-AC-3');
  });
});
