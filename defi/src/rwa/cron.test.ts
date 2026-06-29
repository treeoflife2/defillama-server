jest.mock('./file-cache', () => ({
  storeRouteData: jest.fn(async () => {}),
  storeRouteDataWithWriter: jest.fn(async () => {}),
  clearOldCacheVersions: jest.fn(async () => {}),
  getCacheVersion: jest.fn(() => 'test'),
  getSyncMetadata: jest.fn(async () => null),
  setSyncMetadata: jest.fn(async () => {}),
  storeHistoricalDataForId: jest.fn(async () => {}),
  readHistoricalDataForId: jest.fn(async () => null),
  mergeHistoricalData: jest.fn(() => ({})),
  storePGCacheForId: jest.fn(async () => {}),
  readPGCacheForId: jest.fn(),
  mergePGCacheData: jest.fn(() => ({})),
  getPGSyncMetadata: jest.fn(async () => null),
  setPGSyncMetadata: jest.fn(async () => {}),
  storeFlowsForId: jest.fn(async () => {}),
}));

jest.mock('./db', () => ({
  initPG: jest.fn(async () => {}),
  fetchCurrentPG: jest.fn(async () => []),
  fetchMetadataPG: jest.fn(async () => []),
  fetchAllDailyRecordsPG: jest.fn(async () => []),
  fetchMaxUpdatedAtPG: jest.fn(async () => null),
  fetchAllDailyIdsPG: jest.fn(async () => []),
  fetchDailyRecordsForIdPG: jest.fn(async () => []),
  fetchDailyRecordsWithChainsPG: jest.fn(async () => []),
  fetchDailyRecordsWithChainsForIdPG: jest.fn(async () => []),
  fetchLatestHourlyForChartTipsPG: jest.fn(async () => []),
  computeFlowSeries: jest.fn(() => []),
}));

jest.mock('./alerting', () => ({
  sendThrottledRwaAlert: jest.fn(async () => ({ status: 'sent' })),
}));

jest.mock('../protocols/parentProtocols', () => ({ parentProtocolsById: {} }));
jest.mock('../protocols/data', () => ({ protocolsById: {} }));

import { readPGCacheForId, storeRouteData, storeRouteDataWithWriter } from './file-cache';
import { generateAggregatedHistoricalCharts, appendPGCacheTip, stripPGCacheTips } from './cron';

// One UTC day in seconds; daily PG-cache rows are always start-of-day aligned.
const DAY = 86400;
const D0 = 1699920000; // 2023-11-14 00:00 UTC

function makeTip(timestamp: number, mcap: Record<string, number>): any {
  return {
    id: 'hybond',
    timestamp,
    mcap,
    activemcap: mcap,
    defiactivetvl: {},
    totalsupply: {},
    aggregatemcap: Object.values(mcap).reduce((a, b) => a + b, 0),
    aggregatedactivemcap: Object.values(mcap).reduce((a, b) => a + b, 0),
    aggregatedefiactivetvl: 0,
  };
}

// Asset-breakdown files are written via the streaming `storeRouteDataWithWriter`
// (chunked JSON) rather than `storeRouteData`. Reconstruct each file by re-running
// the real production writer closure and parsing the concatenated chunks, so the
// test asserts against actual prod output instead of a reimplementation.
async function collectStoredRouteData(): Promise<Map<string, any>> {
  const stored = new Map<string, any>(
    (storeRouteData as jest.Mock).mock.calls.map(([path, data]) => [path, data])
  );
  for (const [path, writeData] of (storeRouteDataWithWriter as jest.Mock).mock.calls) {
    let buffer = '';
    await writeData(async (chunk: string) => { buffer += chunk; });
    stored.set(path, JSON.parse(buffer));
  }
  return stored;
}

describe('generateAggregatedHistoricalCharts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readPGCacheForId as jest.Mock).mockImplementation(async (id: string) => ({
      1699920000: {
        onChainMcap: id === 'alpha' ? 100 : 30,
        activeMcap: id === 'alpha' ? 80 : 20,
        defiActiveTvl: id === 'alpha' ? 5 : 2,
        chains: {
          ethereum: {
            onChainMcap: id === 'alpha' ? 100 : 30,
            activeMcap: id === 'alpha' ? 80 : 20,
            defiActiveTvl: id === 'alpha' ? 5 : 2,
          },
        },
      },
    }));
  });

  it('writes category asset-breakdown data for secondary categories without creating secondary aggregate category charts', async () => {
    await generateAggregatedHistoricalCharts([
      {
        id: 'alpha',
        data: {
          canonicalMarketId: 'alpha-market',
          category: ['Treasury Bills', 'Other RWAs'],
          stablecoin: false,
          governance: false,
        },
      },
      {
        id: 'beta',
        data: {
          canonicalMarketId: 'beta-market',
          category: ['Private Credit'],
          stablecoin: false,
          governance: false,
        },
      },
    ]);

    const storedByPath = await collectStoredRouteData();

    expect(storedByPath.has('charts/category/other-rwas.json')).toBe(false);
    expect(storedByPath.has('charts/category/treasury-bills.json')).toBe(true);
    expect(storedByPath.has('charts/category/private-credit.json')).toBe(true);
    expect(storedByPath.get('charts/category-asset-breakdown/other-rwas.json')).toEqual({
      onChainMcap: [{ timestamp: 1699920000, 'alpha-market': 100 }],
      activeMcap: [{ timestamp: 1699920000, 'alpha-market': 80 }],
      defiActiveTvl: [{ timestamp: 1699920000, 'alpha-market': 5 }],
    });
  });
});

describe('PG cache live tip', () => {
  // HYBOND-shaped backbone: a few days flat at ~20k, then a large same-day mint.
  const daily = () => ({
    [D0]: { onChainMcap: 20005, activeMcap: 20005, defiActiveTvl: 0, totalSupply: 11560, chains: { Ethereum: { onChainMcap: 14226, activeMcap: 14226, defiActiveTvl: 0, totalSupply: 5783 } } },
    [D0 + DAY]: { onChainMcap: 20012, activeMcap: 20012, defiActiveTvl: 0, totalSupply: 11562, chains: { Ethereum: { onChainMcap: 14233, activeMcap: 14233, defiActiveTvl: 0, totalSupply: 5783 } } },
  });

  it('appends the hourly tip as a fresh rightmost point with the per-chain breakdown', () => {
    const tipTs = D0 + DAY + 12345; // intraday, after the latest 00:00 row
    const out = appendPGCacheTip(daily(), makeTip(tipTs, { Ethereum: 1607342, BSC: 10003 }));

    expect(Object.keys(out).map(Number).sort((a, b) => a - b)).toEqual([D0, D0 + DAY, tipTs]);
    expect(out[tipTs].onChainMcap).toBe(1617345);
    expect(out[tipTs].chains.Ethereum.onChainMcap).toBe(1607342);
    expect(out[tipTs].chains.BSC.onChainMcap).toBe(10003);
    // The 00:00 row for the same day is kept (so /flows ?withMcap still resolves).
    expect(out[D0 + DAY].onChainMcap).toBe(20012);
  });

  it('does not append a tip that is not newer than the last daily point', () => {
    const out = appendPGCacheTip(daily(), makeTip(D0 + DAY, { Ethereum: 99 }));
    expect(Object.keys(out).map(Number).sort((a, b) => a - b)).toEqual([D0, D0 + DAY]);
  });

  it('is a no-op when there is no tip', () => {
    expect(appendPGCacheTip(daily(), undefined)).toEqual(daily());
  });

  it('stripPGCacheTips removes the intraday tip and is idempotent', () => {
    const tipTs = D0 + DAY + 12345;
    const tipped = appendPGCacheTip(daily(), makeTip(tipTs, { Ethereum: 1607342 }));
    const stripped = stripPGCacheTips(tipped);
    expect(stripped).toEqual(daily());
    expect(stripPGCacheTips(stripped)).toEqual(daily());
  });
});
