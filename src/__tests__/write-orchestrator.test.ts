import { WriteOrchestrator } from '../tools/write-orchestrator';

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('WriteOrchestrator', () => {
  test('runs jobs in parallel when resources differ', async () => {
    const orchestrator = new WriteOrchestrator({
      maxConcurrency: 3,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const start = Date.now();

    const runJob = (resourceKey: string) => orchestrator.enqueue(
      `job:${resourceKey}`,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(35);
        inFlight -= 1;
      },
      { resourceKey },
    );

    await Promise.all([
      runJob('a'),
      runJob('b'),
      runJob('c'),
    ]);

    const duration = Date.now() - start;
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(duration).toBeLessThan(150);
  });

  test('serializes jobs for the same resource key', async () => {
    const orchestrator = new WriteOrchestrator({
      maxConcurrency: 3,
    });

    let inFlightForResource = 0;
    let maxInFlightForResource = 0;

    const runJob = () => orchestrator.enqueue(
      'job:shared',
      async () => {
        inFlightForResource += 1;
        maxInFlightForResource = Math.max(maxInFlightForResource, inFlightForResource);
        await delay(20);
        inFlightForResource -= 1;
      },
      { resourceKey: 'shared' },
    );

    await Promise.all([runJob(), runJob(), runJob()]);
    expect(maxInFlightForResource).toBe(1);
  });

  test('respects team maxInFlight limits for light teams', async () => {
    const orchestrator = new WriteOrchestrator({
      maxConcurrency: 4,
      teams: {
        core: { lane: 'core', maxInFlight: 4, tokenMode: 'standard', weight: 3 },
        reviewer: { lane: 'reviewer', maxInFlight: 1, tokenMode: 'light', weight: 1 },
      },
      defaultTeamId: 'core',
      laneWeights: {
        core: 3,
        reviewer: 1,
      },
    });

    let reviewerInFlight = 0;
    let reviewerPeak = 0;

    const jobs = [
      orchestrator.enqueue('reviewer:1', async () => {
        reviewerInFlight += 1;
        reviewerPeak = Math.max(reviewerPeak, reviewerInFlight);
        await delay(25);
        reviewerInFlight -= 1;
      }, { teamId: 'reviewer', resourceKey: 'r1' }),
      orchestrator.enqueue('reviewer:2', async () => {
        reviewerInFlight += 1;
        reviewerPeak = Math.max(reviewerPeak, reviewerInFlight);
        await delay(25);
        reviewerInFlight -= 1;
      }, { teamId: 'reviewer', resourceKey: 'r2' }),
      orchestrator.enqueue('core:1', async () => delay(25), { teamId: 'core', resourceKey: 'c1' }),
      orchestrator.enqueue('core:2', async () => delay(25), { teamId: 'core', resourceKey: 'c2' }),
    ];

    await Promise.all(jobs);
    expect(reviewerPeak).toBe(1);
  });
});
