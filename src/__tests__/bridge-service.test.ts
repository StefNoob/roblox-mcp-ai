import { jest } from '@jest/globals';
import { BridgeService } from '../bridge-service';

describe('BridgeService', () => {
  let bridgeService: BridgeService;

  beforeEach(() => {
    bridgeService = new BridgeService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Request Management', () => {
    test('should create and store a pending request', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };

      bridgeService.sendRequest(endpoint, data);

      const pendingRequest = bridgeService.getPendingRequest();
      expect(pendingRequest).toBeTruthy();
      expect(pendingRequest?.request.endpoint).toBe(endpoint);
      expect(pendingRequest?.request.data).toEqual(data);
    });

    test('should resolve request when response is received', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };
      const response = { result: 'success' };

      const requestPromise = bridgeService.sendRequest(endpoint, data);
      const pendingRequest = bridgeService.getPendingRequest();

      bridgeService.resolveRequest(pendingRequest!.requestId, response);

      const result = await requestPromise;
      expect(result).toEqual(response);
    });

    test('should reject request on error', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };
      const error = 'Test error';

      const requestPromise = bridgeService.sendRequest(endpoint, data);
      const pendingRequest = bridgeService.getPendingRequest();

      bridgeService.rejectRequest(pendingRequest!.requestId, error);

      await expect(requestPromise).rejects.toEqual(error);
    });

    test('should timeout request after 30 seconds', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };

      const requestPromise = bridgeService.sendRequest(endpoint, data);

      jest.advanceTimersByTime(31000);

      await expect(requestPromise).rejects.toThrow('Request timeout');
    });
  });

  describe('Cleanup Operations', () => {
    test('should clean up old requests', async () => {

      const promises = [
        bridgeService.sendRequest('/api/test1', {}),
        bridgeService.sendRequest('/api/test2', {}),
        bridgeService.sendRequest('/api/test3', {})
      ];

      jest.advanceTimersByTime(31000);

      bridgeService.cleanupOldRequests();

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Request timeout');
      }

      expect(bridgeService.getPendingRequest()).toBeNull();
    });

    test('should clear all pending requests on disconnect', async () => {

      const promises = [
        bridgeService.sendRequest('/api/test1', {}),
        bridgeService.sendRequest('/api/test2', {}),
        bridgeService.sendRequest('/api/test3', {})
      ];

      bridgeService.clearAllPendingRequests();

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Connection closed');
      }

      expect(bridgeService.getPendingRequest()).toBeNull();
    });
  });

  describe('Stats', () => {
    test('should expose bridge stats and update counts', async () => {
      const statsStart = bridgeService.getStats();
      expect(statsStart.totalRequests).toBe(0);
      expect(statsStart.inFlightRequests).toBe(0);

      const requestPromise = bridgeService.sendRequest('/api/test', { foo: 'bar' });
      const pending = bridgeService.getPendingRequest();
      expect(pending).toBeTruthy();

      const statsPending = bridgeService.getStats();
      expect(statsPending.totalRequests).toBe(1);
      expect(statsPending.inFlightRequests).toBe(1);

      bridgeService.resolveRequest(pending!.requestId, { ok: true });
      await expect(requestPromise).resolves.toEqual({ ok: true });

      const statsDone = bridgeService.getStats();
      expect(statsDone.totalResolved).toBe(1);
      expect(statsDone.totalRejected).toBe(0);
      expect(statsDone.inFlightRequests).toBe(0);
    });
  });

  describe('Request Priority', () => {
    test('should return oldest request first', async () => {

      bridgeService.sendRequest('/api/test1', { order: 1 });

      jest.advanceTimersByTime(10);

      bridgeService.sendRequest('/api/test2', { order: 2 });

      jest.advanceTimersByTime(10);

      bridgeService.sendRequest('/api/test3', { order: 3 });

      const firstRequest = bridgeService.getPendingRequest();
      expect(firstRequest?.request.data.order).toBe(1);

      bridgeService.resolveRequest(firstRequest!.requestId, {});

      const secondRequest = bridgeService.getPendingRequest();
      expect(secondRequest?.request.data.order).toBe(2);

      bridgeService.resolveRequest(secondRequest!.requestId, {});

      const thirdRequest = bridgeService.getPendingRequest();
      expect(thirdRequest?.request.data.order).toBe(3);

      bridgeService.resolveRequest(thirdRequest!.requestId, {});

      expect(bridgeService.getPendingRequest()).toBeNull();
    });
  });

  describe('Studio Session Metadata', () => {
    test('should store place metadata for studio sessions', () => {
      bridgeService.upsertStudioSession('studio-a', {
        ready: true,
        lastSeenAt: Date.now(),
        placeId: 123456,
        placeName: 'Session Place',
      });

      const [session] = bridgeService.getStudioSessions();
      expect(session?.sessionId).toBe('studio-a');
      expect(session?.placeId).toBe(123456);
      expect(session?.placeName).toBe('Session Place');
    });

    test('should preserve existing place metadata on partial session updates', () => {
      bridgeService.upsertStudioSession('studio-a', {
        ready: true,
        lastSeenAt: Date.now(),
        placeId: 123456,
        placeName: 'Session Place',
      });
      bridgeService.upsertStudioSession('studio-a', {
        ready: false,
      });

      const [session] = bridgeService.getStudioSessions();
      expect(session?.ready).toBe(false);
      expect(session?.placeId).toBe(123456);
      expect(session?.placeName).toBe('Session Place');
    });
  });

  describe('Session Routing', () => {
    test('should prioritize requests targeted to polling session', async () => {
      bridgeService.sendRequest('/api/unscoped', { order: 1 });
      bridgeService.sendRequest('/api/source', { order: 2 }, { sessionId: 'source' });
      bridgeService.sendRequest('/api/target', { order: 3 }, { sessionId: 'target' });

      const targetPending = bridgeService.getPendingRequest('target');
      expect(targetPending?.request.endpoint).toBe('/api/target');

      const sourcePending = bridgeService.getPendingRequest('source');
      expect(sourcePending?.request.endpoint).toBe('/api/source');
    });

    test('should not redeliver a leased request before it is resolved', async () => {
      const requestPromise = bridgeService.sendRequest('/api/target', { ok: true }, { sessionId: 'target' });
      requestPromise.catch(() => {});

      const firstLease = bridgeService.getPendingRequest('target');
      expect(firstLease?.request.endpoint).toBe('/api/target');

      const secondLease = bridgeService.getPendingRequest('target');
      expect(secondLease).toBeNull();

      bridgeService.resolveRequest(firstLease!.requestId, { done: true });
      await expect(requestPromise).resolves.toEqual({ done: true });
    });

    test('should fall back to unscoped request when no targeted request exists', async () => {
      bridgeService.sendRequest('/api/unscoped', { ok: true });
      const pending = bridgeService.getPendingRequest('missing');
      expect(pending?.request.endpoint).toBe('/api/unscoped');
      expect(pending?.request.targetSessionId).toBeUndefined();
    });

    test('should clear only requests for disconnected session', async () => {
      const sourcePromise = bridgeService.sendRequest('/api/source', { ok: true }, { sessionId: 'source' });
      const targetPromise = bridgeService.sendRequest('/api/target', { ok: true }, { sessionId: 'target' });
      sourcePromise.catch(() => {});
      targetPromise.catch(() => {});

      bridgeService.clearPendingRequestsForSession('source');

      await expect(sourcePromise).rejects.toThrow('Connection closed for session source');

      const pending = bridgeService.getPendingRequest('target');
      expect(pending?.request.endpoint).toBe('/api/target');
      bridgeService.resolveRequest(pending!.requestId, { ok: true });
      await expect(targetPromise).resolves.toEqual({ ok: true });
    });
  });
});
