require("dotenv").config();

import {
  storeRouteData,
  storeRouteDataWithWriter,
  clearOldCacheVersions,
  getCacheVersion,
  getSyncMetadata,
  setSyncMetadata,
  storeHistoricalDataForId,
  readHistoricalDataForId,
  mergeHistoricalData,
  storePGCacheForId,
  readPGCacheForId,
  mergePGCacheData,
  PGCacheData,
  PGCacheRecord,
  getPGSyncMetadata,
  setPGSyncMetadata,
  storeFlowsForId,
  readFlowsForId,
} from './file-cache';
import { initPG, fetchCurrentPG, fetchMetadataPG, fetchAllDailyRecordsPG, fetchMaxUpdatedAtPG, fetchAllDailyIdsPG, fetchDailyRecordsForIdPG, fetchDailyRecordsWithChainsPG, fetchDailyRecordsWithChainsForIdPG, fetchLatestHourlyForChartTipsPG, ChartTipRow, computeFlowSeries, FlowRow, FlowPoint, DailyFlow, aggregateFlows, sumFlowWindow, FlowAggregateResult } from './db';
import { getTimestampAtStartOfDay } from '../utils/date';

import { shouldEmitRwaBreakdownItem } from './chartBreakdown';
import { rwaSlug, toFiniteNumberOrZero, smoothHistoricalData, normalizeRwaMetadataForApiInPlace } from './utils';
import { parentProtocolsById } from '../protocols/parentProtocols';
import { protocolsById } from '../protocols/data';
import { getChainLabelFromKey } from '../utils/normalizeChain';
import { FLOWS_HIDDEN_IDS } from './metadataConstants';
import { sendThrottledRwaAlert } from './alerting';
import {
  formatRwaHistoricalChartGuardReport,
  formatUsd,
  getSuspiciousRwaHistoricalChartReport,
  hasSuspiciousRwaHistoricalChartReport,
  timestampToDay,
} from './chartGuards';

const MIN_PG_CACHE_ROWS_FOR_INCREMENTAL_REUSE = Number(process.env.RWA_MIN_PG_CACHE_ROWS_FOR_INCREMENTAL_REUSE ?? 30);
const RWA_CHART_ALERT_MIN_SINGLE_POINT_MCAP = Number(process.env.RWA_CHART_ALERT_MIN_SINGLE_POINT_MCAP ?? 50_000_000);
const RWA_CHART_ALERT_MIN_DAY_DELTA = Number(process.env.RWA_CHART_ALERT_MIN_DAY_DELTA ?? 500_000_000);
const RWA_CHART_ALERT_MIN_DAY_RATIO = Number(process.env.RWA_CHART_ALERT_MIN_DAY_RATIO ?? 0.05);
const RWA_CHART_ALERT_MAX_ITEMS = Number(process.env.RWA_CHART_ALERT_MAX_ITEMS ?? 12);
const RWA_CHART_ALERT_LOOKBACK_DAYS = Number(process.env.RWA_CHART_ALERT_LOOKBACK_DAYS ?? 1);
const RWA_CHART_ALERT_FAIL_ON_SUSPICIOUS = process.env.RWA_CHART_ALERT_FAIL_ON_SUSPICIOUS !== 'false';
const RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES = process.env.RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES === 'true';
const RWA_CHART_ALERT_MIN_INTERVAL_HOURS = Number(process.env.RWA_CHART_ALERT_MIN_INTERVAL_HOURS ?? 4);
const RWA_CHART_ALERT_MIN_INTERVAL_MS = RWA_CHART_ALERT_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
const RWA_HISTORICAL_CHART_GUARD_ALERT_KEY = 'historicalChartGuard';

interface RWACurrentData {
  id: string;
  timestamp: number;
  defiactivetvl: object;
  mcap: object;
  activemcap: object;
}

// Convert chain keys to chain labels in an object, coercing values to numbers
function convertChainKeysToLabelsNumber(obj: { [chainKey: string]: any }): { [chainLabel: string]: number } {
  const result: { [chainLabel: string]: number } = {};
  if (!obj || typeof obj !== 'object') return result;
  for (const chainKey of Object.keys(obj)) {
    const chainLabel = getChainLabelFromKey(chainKey);
    result[chainLabel] = toFiniteNumberOrZero(obj[chainKey]);
  }
  return result;
}

// Convert chain keys to chain labels in a nested object, coercing inner values to numbers
function convertChainKeysToLabelsNestedNumber(
  obj: { [chainKey: string]: any }
): { [chainLabel: string]: { [key: string]: number } } {
  const result: { [chainLabel: string]: { [key: string]: number } } = {};
  if (!obj || typeof obj !== 'object') return result;
  for (const chainKey of Object.keys(obj)) {
    const chainLabel = getChainLabelFromKey(chainKey);
    const protocols = obj[chainKey];
    const outProtocols: { [key: string]: number } = {};
    if (protocols && typeof protocols === 'object') {
      for (const [protocolKey, value] of Object.entries(protocols)) {
        const isTreasury = protocolKey.endsWith('-treasury');
        const normalizedProtocolKey = isTreasury ? protocolKey.slice(0, -'-treasury'.length) : protocolKey;
        const protocolLabel = (normalizedProtocolKey.startsWith('parent#')
          ? parentProtocolsById[normalizedProtocolKey]?.name
          : protocolsById[normalizedProtocolKey]?.name) ?? protocolKey;
        const finalProtocolLabel = isTreasury ? `${protocolLabel} (Treasury)` : protocolLabel;
        outProtocols[finalProtocolLabel] = toFiniteNumberOrZero(value);
      }
    }
    result[chainLabel] = outProtocols;
  }
  return result;
}

interface RWAMetadata {
  id: string;
  data: any;
}

async function sendThrottledRwaHistoricalChartGuardAlert(message: string): Promise<void> {
  try {
    await sendThrottledRwaAlert({
      alertKey: RWA_HISTORICAL_CHART_GUARD_ALERT_KEY,
      message,
      minIntervalMs: RWA_CHART_ALERT_MIN_INTERVAL_MS,
      onSuppress: (throttleUntil) => {
        console.warn(
          `[RWA cron] Suppressing repeated suspicious RWA historical chart alert until ${new Date(throttleUntil).toISOString()}`
        );
      },
    });
  } catch (alertError) {
    console.error('[RWA cron] Failed to send suspicious historical chart alert:', (alertError as any)?.message);
  }
}

async function generateCurrentData(metadata: RWAMetadata[]): Promise<any[]> {
  console.log('Generating current RWA data...');
  const startTime = Date.now();

  const current = await fetchCurrentPG();
  const currentMap: { [id: string]: RWACurrentData } = {};
  current.forEach((c: any) => { currentMap[c.id] = c; });

  const data: any[] = [];
  let timestamp = 0;

  metadata.forEach((m: RWAMetadata) => {
    const idCurrent = currentMap[m.id]
    m.data.id = m.id

    if (!idCurrent) return;

    if (idCurrent.timestamp > timestamp) timestamp = idCurrent.timestamp;

    // Expose camelCase fields in API responses; do not expose "mcap" (use "onChainMcap" instead).
    delete (m.data as any).mcap;
    m.data.onChainMcap = convertChainKeysToLabelsNumber(idCurrent.mcap as any);
    if (m.data.activeMcapData) m.data.activeMcap = convertChainKeysToLabelsNumber(idCurrent.activemcap as any);
    m.data.defiActiveTvl = convertChainKeysToLabelsNestedNumber(idCurrent.defiactivetvl as any);
    if (!m.data.canonicalMarketId) return;

    data.push(m.data);
  });

  console.log(`Generated current data in ${Date.now() - startTime}ms`);
  return data;
}

function generateIdMap(
  metadata: Array<{ id: string; data: any; ticker: string }>
): { [name: string]: string } {
  const idMap: { [name: string]: string } = {};

  metadata.forEach((m: RWAMetadata) => {
    const canonicalMarketId = m.data.canonicalMarketId
    const id = m.id
    if (canonicalMarketId && id) idMap[canonicalMarketId] = id;
  });

  return idMap;
}

export function trimLeadingZeros<T extends { timestamp: number; onChainMcap: number; defiActiveTvl: number; activeMcap?: number }>(data: T[]): T[] {
  while (data.length > 0) {
    const first = data[0];
    if (first.onChainMcap === 0 && first.defiActiveTvl === 0 && (!first.activeMcap || first.activeMcap === 0)) {
      data.shift();
    } else {
      break;
    }
  }
  return data;
}

// Live-tip handling: charts are built from DAILY (start-of-day timestamps),
// but we append one extra point per id from the latest HOURLY row so the
// rightmost point reflects the latest cron-tick values, not the early-morning
// DAILY snapshot that the closest-to-midnight gate can pin us to.
// stripLiveTips removes any prior tip before re-building so points stay
// idempotent across runs (cleanly daily-aligned + at most one trailing tip).
export function stripLiveTips<T extends { timestamp: number }>(data: T[]): T[] {
  if (!data || data.length === 0) return data;
  return data.filter((r) => r.timestamp === getTimestampAtStartOfDay(r.timestamp));
}

function appendChartTip(
  dailyChart: Array<{ timestamp: number; onChainMcap: number; defiActiveTvl: number; activeMcap?: number }>,
  tip: ChartTipRow | undefined,
  hasActiveMcapData: boolean,
): Array<{ timestamp: number; onChainMcap: number; defiActiveTvl: number; activeMcap?: number }> {
  if (!tip) return dailyChart;
  // If the tip is for the same UTC day as the last daily point, drop the daily
  // point — the hourly tip is strictly fresher than the start-of-day daily row,
  // and keeping both would leave a visible step between the (possibly stale)
  // 00:00 daily value and the current tip value.
  const tipDayStart = getTimestampAtStartOfDay(tip.timestamp);
  const lastDailyTs = dailyChart.length > 0 ? dailyChart[dailyChart.length - 1].timestamp : 0;
  if (lastDailyTs === tipDayStart) dailyChart.pop();
  const newLast = dailyChart.length > 0 ? dailyChart[dailyChart.length - 1].timestamp : 0;
  if (tip.timestamp <= newLast) return dailyChart;
  dailyChart.push({
    timestamp: tip.timestamp,
    onChainMcap: tip.aggregatemcap,
    defiActiveTvl: tip.aggregatedefiactivetvl,
    activeMcap: hasActiveMcapData ? tip.aggregatedactivemcap : undefined,
  });
  return dailyChart;
}

async function generateAllHistoricalDataIncremental(metadata: RWAMetadata[]): Promise<{ updatedIds: number; totalRecords: number }> {
  console.log('Generating historical data incrementally...');
  const startTime = Date.now();

  // Create a map of id -> activeMcapData for quick lookup
  const activeMcapDataMap: { [id: string]: boolean } = {};
  metadata.forEach((m) => {
    activeMcapDataMap[m.id] = !!m.data.activeMcapData;
  });

  // Get sync metadata to determine if this is a full or incremental sync
  const syncMetadata = await getSyncMetadata();
  const lastSyncTimestamp = syncMetadata?.lastSyncTimestamp
    ? new Date(syncMetadata.lastSyncTimestamp)
    : undefined;

  let updatedIds = 0;
  let totalRecords = 0;

  // Latest HOURLY row per id provides a live tip that's appended to the
  // (daily-aligned) chart series after smoothing. Fetched once upfront so the
  // per-id loop is just a map lookup.
  const latestHourlyTips = await fetchLatestHourlyForChartTipsPG();

  if (lastSyncTimestamp) {
    // Incremental sync: fetch only updated records
    console.log(`Incremental sync: fetching records updated after ${lastSyncTimestamp.toISOString()}`);

    const dailyRecords = await fetchAllDailyRecordsPG(lastSyncTimestamp);
    console.log(`Fetched ${dailyRecords.length} updated daily records from database`);

    // Group records by ID
    const recordsById: { [id: string]: any[] } = {};
    dailyRecords.forEach((record) => {
      if (!recordsById[record.id]) {
        recordsById[record.id] = [];
      }
      const activeMcapData = activeMcapDataMap[record.id] ?? false;
      recordsById[record.id].push({
        timestamp: record.timestamp,
        // Sequelize returns DECIMAL as string; normalize to numbers for API consumers
        onChainMcap: toFiniteNumberOrZero(record.aggregatemcap),
        defiActiveTvl: toFiniteNumberOrZero(record.aggregatedefiactivetvl),
        activeMcap: activeMcapData ? toFiniteNumberOrZero(record.aggregatedactivemcap) : undefined,
      });
    });

    // Process the union of (ids with new daily rows) and (ids with a hourly tip)
    // so the tip stays fresh on every cron tick, even for ids whose daily row
    // didn't change this run.
    const ids = Array.from(new Set([...Object.keys(recordsById), ...Object.keys(latestHourlyTips)]));
    console.log(`Processing ${ids.length} unique IDs (with daily updates or hourly tip)`);

    for (const id of ids) {
      try {
        const newRecords = recordsById[id] ?? [];
        const existingData = await readHistoricalDataForId(id);
        if ((!existingData || existingData.length === 0) && newRecords.length === 0) continue;
        const existingNoTip = stripLiveTips(existingData ?? []);
        const mergedData = mergeHistoricalData(existingNoTip, newRecords);
        const dailyOnly = trimLeadingZeros(smoothHistoricalData(mergedData));
        const withTip = appendChartTip(dailyOnly, latestHourlyTips[id], activeMcapDataMap[id] ?? false);
        await storeHistoricalDataForId(id, withTip);
        updatedIds++;
        totalRecords += newRecords.length;
      } catch (e) {
        console.error(`Error processing historical data for ${id}:`, (e as any)?.message);
      }
    }
  } else {
    // Full sync: fetch one ID at a time to avoid memory issues
    console.log('Full sync: fetching all daily records one ID at a time');

    const allIds = await fetchAllDailyIdsPG();
    console.log(`Found ${allIds.length} unique IDs to process`);

    for (let i = 0; i < allIds.length; i++) {
      const id = allIds[i];
      try {
        const records = await fetchDailyRecordsForIdPG(id);
        if (records.length === 0) continue;

        const activeMcapData = activeMcapDataMap[id] ?? false;
        const historicalData = records.map((record) => ({
          timestamp: record.timestamp,
          // Sequelize returns DECIMAL as string; normalize to numbers for API consumers
          onChainMcap: toFiniteNumberOrZero(record.aggregatemcap),
          defiActiveTvl: toFiniteNumberOrZero(record.aggregatedefiactivetvl),
          activeMcap: activeMcapData ? toFiniteNumberOrZero(record.aggregatedactivemcap) : undefined,
        }));

        const dailyOnly = trimLeadingZeros(smoothHistoricalData(historicalData));
        const withTip = appendChartTip(dailyOnly, latestHourlyTips[id], activeMcapData);
        await storeHistoricalDataForId(id, withTip);
        updatedIds++;
        totalRecords += records.length;

        if ((i + 1) % 100 === 0) {
          console.log(`Processed ${i + 1}/${allIds.length} IDs`);
        }
      } catch (e) {
        console.error(`Error processing historical data for ${id}:`, (e as any)?.message);
      }
    }
  }

  // Update sync metadata
  const maxUpdatedAt = await fetchMaxUpdatedAtPG();
  await setSyncMetadata({
    lastSyncTimestamp: maxUpdatedAt?.toISOString() || null,
    lastSyncDate: new Date().toISOString(),
    totalIds: updatedIds,
  });

  console.log(`Generated historical data for ${updatedIds} IDs in ${Date.now() - startTime}ms`);
  return { updatedIds, totalRecords };
}

function sumObjectValues(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  return Object.values(obj as Record<string, any>).reduce((sum: number, val: any) => {
    const num = Number(val);
    return sum + (isNaN(num) ? 0 : num);
  }, 0);
}

const PG_CACHE_METRICS = ['onChainMcap', 'activeMcap', 'defiActiveTvl', 'totalSupply'] as const;

// Maximum consecutive anomalous days to bridge (must match utils.ts MAX_SPIKE_RUN)
const MAX_SPIKE_RUN = 5;

/**
 * Applies forward-looking spike removal to a single numeric stream within
 * the PG-cache entries array.  Mutates entries in place.
 *
 * `getValue` / `setValue` abstract over whether we're operating on the
 * aggregate level or on a specific chain's metric.
 */
function removePGSpikes(
  entries: Array<{ timestamp: number; [k: string]: any }>,
  getValue: (entry: any) => number,
  setValue: (entry: any, v: number) => void
) {
  if (entries.length < 3) return;

  let lastGoodIdx = 0;
  let i = 1;

  while (i < entries.length) {
    const lastGoodVal = getValue(entries[lastGoodIdx]);
    const currVal = getValue(entries[i]);

    if (!Number.isFinite(lastGoodVal) || !Number.isFinite(currVal) || lastGoodVal < 1) {
      lastGoodIdx = i; i++; continue;
    }

    const ratio = currVal / lastGoodVal;
    if (ratio >= 0.1 && ratio <= 10) { lastGoodIdx = i; i++; continue; }

    // Anomalous — scan ahead for next good reference
    let nextGoodIdx = -1;
    for (let j = i + 1; j < Math.min(i + MAX_SPIKE_RUN + 1, entries.length); j++) {
      const jVal = getValue(entries[j]);
      if (!Number.isFinite(jVal)) break;
      const jRatio = jVal / lastGoodVal;
      if (jRatio >= 0.2 && jRatio <= 5) { nextGoodIdx = j; break; }
    }

    if (nextGoodIdx === -1) { lastGoodIdx = i; i++; continue; }

    // Interpolate the entire anomalous run [i, nextGoodIdx)
    const prevTs = entries[lastGoodIdx].timestamp;
    const nextTs = entries[nextGoodIdx].timestamp;
    const nextVal = getValue(entries[nextGoodIdx]);

    for (let k = i; k < nextGoodIdx; k++) {
      const t = (entries[k].timestamp - prevTs) / (nextTs - prevTs);
      setValue(entries[k], lastGoodVal + (nextVal - lastGoodVal) * t);
    }

    lastGoodIdx = nextGoodIdx;
    i = nextGoodIdx + 1;
  }
}

/**
 * Smooths PG cache time-series data (chain-level breakdown) by:
 *   1. Removing spikes/dips (including multi-day runs) at aggregate and per-chain level.
 *   2. Filling multi-day gaps with linear interpolation.
 * totalSupply nulls are preserved (no synthesised values, no gap interpolation).
 */
export function smoothPGCacheData(data: PGCacheData): PGCacheData {
  const timestamps = Object.keys(data).map(Number).sort((a, b) => a - b);
  if (timestamps.length < 2) return data;

  const allChainKeys = new Set<string>();
  timestamps.forEach((ts) => Object.keys(data[ts].chains || {}).forEach((k) => allChainKeys.add(k)));

  // Build a mutable working copy as a sorted array
  type Entry = { timestamp: number } & PGCacheRecord;
  const entries: Entry[] = timestamps.map((ts) => ({
    timestamp: ts,
    onChainMcap: data[ts].onChainMcap,
    activeMcap: data[ts].activeMcap,
    defiActiveTvl: data[ts].defiActiveTvl,
    totalSupply: data[ts].totalSupply,
    chains: Object.fromEntries(
      Object.entries(data[ts].chains || {}).map(([k, v]) => [k, { ...v }])
    ),
  }));

  // Step 1: remove spikes/dips — aggregate metrics
  for (const metric of PG_CACHE_METRICS) {
    removePGSpikes(
      entries,
      (e) => (e[metric] === null ? NaN : e[metric]),
      (e, v) => {
        if (metric === 'totalSupply' && e[metric] === null) return;
        e[metric] = v;
      }
    );
  }

  // Step 1b: remove spikes/dips — per-chain metrics
  const defaultPGChain = { onChainMcap: 0, activeMcap: 0, defiActiveTvl: 0, totalSupply: null as number | null };
  for (const chainKey of allChainKeys) {
    for (const metric of PG_CACHE_METRICS) {
      removePGSpikes(
        entries,
        (e) => {
          const v = (e.chains[chainKey] ?? defaultPGChain)[metric];
          return v === null ? NaN : v;
        },
        (e, v) => {
          if (!e.chains[chainKey]) e.chains[chainKey] = { ...defaultPGChain };
          if (metric === 'totalSupply' && e.chains[chainKey].totalSupply === null) return;
          e.chains[chainKey][metric] = v;
        }
      );
    }
  }

  // Step 2: fill gaps with linear interpolation
  const interpSupply = (a: number | null, b: number | null, f: number): number | null =>
    a === null || b === null ? null : a + (b - a) * f;
  const result: PGCacheData = {};
  for (let i = 0; i < entries.length; i++) {
    const { timestamp, chains, onChainMcap, activeMcap, defiActiveTvl, totalSupply } = entries[i];
    result[timestamp] = { onChainMcap, activeMcap, defiActiveTvl, totalSupply, chains };

    if (i < entries.length - 1) {
      const curr = entries[i];
      const next = entries[i + 1];
      const daysDiff = Math.round((next.timestamp - curr.timestamp) / 86400);

      for (let j = 1; j < daysDiff; j++) {
        const f = j / daysDiff;
        const intTs = curr.timestamp + 86400 * j;
        const intChains: PGCacheRecord['chains'] = {};
        for (const chainKey of allChainKeys) {
          const cC = curr.chains[chainKey] ?? defaultPGChain;
          const nC = next.chains[chainKey] ?? defaultPGChain;
          intChains[chainKey] = {
            onChainMcap: cC.onChainMcap + (nC.onChainMcap - cC.onChainMcap) * f,
            activeMcap: cC.activeMcap + (nC.activeMcap - cC.activeMcap) * f,
            defiActiveTvl: cC.defiActiveTvl + (nC.defiActiveTvl - cC.defiActiveTvl) * f,
            totalSupply: interpSupply(cC.totalSupply, nC.totalSupply, f),
          };
        }
        result[intTs] = {
          onChainMcap: curr.onChainMcap + (next.onChainMcap - curr.onChainMcap) * f,
          activeMcap: curr.activeMcap + (next.activeMcap - curr.activeMcap) * f,
          defiActiveTvl: curr.defiActiveTvl + (next.defiActiveTvl - curr.defiActiveTvl) * f,
          totalSupply: interpSupply(curr.totalSupply, next.totalSupply, f),
          chains: intChains,
        };
      }
    }
  }

  return result;
}

export function processRecordsToPGCache(records: any[]): PGCacheData {
  const data: PGCacheData = {};
  // totalSupply: null = unknown, 0 = real zero. Chains with mcap > 0 but
  // missing from supplyObj stay null (data gap, not real zero).
  const newChainEntry = () => ({ onChainMcap: 0, activeMcap: 0, defiActiveTvl: 0, totalSupply: null as number | null });
  for (const record of records) {
    const { mcap: mcapObj, activemcap: activemcapObj, defiactivetvl: defitvlObj, totalsupply: totalsupplyObj } = record;
    const supplyObj = totalsupplyObj || {};

    const chains: PGCacheRecord['chains'] = {};
    let totalOnChainMcap = 0;
    let totalActiveMcap = 0;
    let totalDefiActiveTvl = 0;

    for (const [chainKey, value] of Object.entries(toObjectMap(mcapObj))) {
      if (!chains[chainKey]) chains[chainKey] = newChainEntry();
      const numValue = Number(value) || 0;
      chains[chainKey].onChainMcap = numValue;
      totalOnChainMcap += numValue;
    }

    for (const [chainKey, value] of Object.entries(toObjectMap(activemcapObj))) {
      if (!chains[chainKey]) chains[chainKey] = newChainEntry();
      const numValue = Number(value) || 0;
      chains[chainKey].activeMcap = numValue;
      totalActiveMcap += numValue;
    }

    for (const [chainKey, protocols] of Object.entries(toObjectMap(defitvlObj))) {
      if (!chains[chainKey]) chains[chainKey] = newChainEntry();
      const numValue = sumObjectValues(protocols);
      chains[chainKey].defiActiveTvl = numValue;
      totalDefiActiveTvl += numValue;
    }

    for (const [chainKey, value] of Object.entries(supplyObj)) {
      if (!chains[chainKey]) chains[chainKey] = newChainEntry();
      chains[chainKey].totalSupply = Number(value) || 0;
    }

    // For chains with mcap entry but no supplyObj entry: 0 mcap means real zero, else unknown.
    for (const chainKey of Object.keys(chains)) {
      if (chains[chainKey].totalSupply !== null) continue;
      if (chains[chainKey].onChainMcap === 0) chains[chainKey].totalSupply = 0;
    }

    // Aggregate = sum of known chains. Null only when every chain is unknown but mcap > 0.
    let totalSupplyAgg: number | null = 0;
    let anyKnown = false;
    for (const c of Object.values(chains)) {
      if (c.totalSupply === null) continue;
      anyKnown = true;
      totalSupplyAgg += c.totalSupply;
    }
    if (!anyKnown && totalOnChainMcap > 0) totalSupplyAgg = null;

    data[record.timestamp] = {
      onChainMcap: totalOnChainMcap,
      activeMcap: totalActiveMcap,
      defiActiveTvl: totalDefiActiveTvl,
      totalSupply: totalSupplyAgg,
      chains,
    };
  }
  return data;
}

// Drop any prior live tip (non-midnight rows) so the daily backbone stays clean and idempotent.
export function stripPGCacheTips(data: PGCacheData | null): PGCacheData {
  const out: PGCacheData = {};
  if (!data) return out;
  for (const ts of Object.keys(data)) {
    const t = Number(ts);
    if (t === getTimestampAtStartOfDay(t)) out[t] = data[t];
  }
  return out;
}

// Append the latest hourly row as a live tip so the chart's right edge tracks the current value, not the 00:00 row.
export function appendPGCacheTip(data: PGCacheData, tip: ChartTipRow | undefined): PGCacheData {
  if (!tip) return data;
  const tipRecord = processRecordsToPGCache([{
    timestamp: tip.timestamp,
    mcap: tip.mcap,
    activemcap: tip.activemcap,
    defiactivetvl: tip.defiactivetvl,
    totalsupply: tip.totalsupply,
  }])[tip.timestamp];
  if (!tipRecord) return data;
  const lastTs = Object.keys(data).reduce((max, ts) => Math.max(max, Number(ts)), 0);
  if (tip.timestamp <= lastTs) return data;
  data[tip.timestamp] = tipRecord;
  return data;
}

// Pre-compute the daily net-flow series for one id from already-fetched
// chain-level daily records. Mirrors the logic the /flows/:id route used to
// run on every request.
export function computeFlowsFromChainRecords(records: any[]) {
  const flowRows: FlowRow[] = records.map((r) => ({
    timestamp: r.timestamp,
    mcap: r.mcap || {},
    totalsupply: r.totalsupply || {},
  }));
  return computeFlowSeries(flowRows, getChainLabelFromKey);
}

async function storeFlowsForIdFromChainRecords(id: string, records: any[]): Promise<void> {
  await storeFlowsForId(id, computeFlowsFromChainRecords(records));
}

function toObjectMap(value: any): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

type PGCacheRepairEvent = {
  id: string;
  reason: string;
  existingRows: number;
  rebuiltRows: number;
  incrementalRows: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
};

type PGCacheProcessingError = {
  id: string;
  message: string;
};

function getPGCacheRowCount(cache: PGCacheData | null): number {
  return cache ? Object.keys(cache).length : 0;
}

function getRecordRange(records: any[]): { firstTimestamp?: number; lastTimestamp?: number } {
  const timestamps = records.map((record) => Number(record.timestamp)).filter((timestamp) => Number.isFinite(timestamp));
  if (!timestamps.length) return {};
  timestamps.sort((a, b) => a - b);
  return { firstTimestamp: timestamps[0], lastTimestamp: timestamps[timestamps.length - 1] };
}

async function alertPGCacheRepairs(events: PGCacheRepairEvent[]): Promise<void> {
  if (!events.length) return;
  const lines = events
    .slice(0, RWA_CHART_ALERT_MAX_ITEMS)
    .map((event) => {
      const range = event.firstTimestamp && event.lastTimestamp
        ? `${timestampToDay(event.firstTimestamp)} -> ${timestampToDay(event.lastTimestamp)}`
        : 'empty';
      return `- ${event.id}: ${event.reason}; cache rows ${event.existingRows} -> ${event.rebuiltRows}; incremental rows ${event.incrementalRows}; range ${range}`;
    });
  const suffix = events.length > lines.length ? `\n...and ${events.length - lines.length} more IDs` : '';
  try {
    await sendThrottledRwaAlert({
      alertKey: 'pgCacheRepairs',
      message: `Rebuilt incomplete RWA pg-cache entries during incremental sync.\n` +
      `This prevents old DB history from being dropped from /chart/asset and aggregate charts.\n` +
      lines.join('\n') +
      suffix,
    });
  } catch (alertError) {
    console.error('[RWA cron] Failed to send pg-cache repair alert:', (alertError as any)?.message);
  }
}

async function alertPGCacheProcessingErrors(errors: PGCacheProcessingError[]): Promise<void> {
  if (!errors.length) return;
  const lines = errors
    .slice(0, RWA_CHART_ALERT_MAX_ITEMS)
    .map((error) => `- ${error.id}: ${error.message}`);
  const suffix = errors.length > lines.length ? `\n...and ${errors.length - lines.length} more IDs` : '';
  try {
    await sendThrottledRwaAlert({
      alertKey: 'pgCacheProcessingErrors',
      message: `Failed to generate RWA pg-cache for ${errors.length} IDs; refusing to publish incomplete historical cache.\n` +
      lines.join('\n') +
      suffix,
    });
  } catch (alertError) {
    console.error('[RWA cron] Failed to send pg-cache processing error alert:', (alertError as any)?.message);
  }
}

async function generatePGCache(): Promise<{ updatedIds: number }> {
  console.log('Generating PG cache with chain breakdown...');
  const startTime = Date.now();

  const syncMetadata = await getPGSyncMetadata();
  const lastSyncTimestamp = syncMetadata?.lastSyncTimestamp
    ? new Date(syncMetadata.lastSyncTimestamp)
    : undefined;

  let updatedIds = 0;
  const repairEvents: PGCacheRepairEvent[] = [];
  const processingErrors: PGCacheProcessingError[] = [];

  // Latest hourly row per id, appended below as a live chart tip (fetched once).
  const latestHourlyTips = await fetchLatestHourlyForChartTipsPG();

  if (lastSyncTimestamp) {
    // Incremental sync: fetch only updated records
    console.log(`Incremental PG cache sync: fetching records updated after ${lastSyncTimestamp.toISOString()}`);
    const records = await fetchDailyRecordsWithChainsPG(lastSyncTimestamp);
    console.log(`Fetched ${records.length} updated records for PG cache`);

    // Group by ID
    const recordsById: { [id: string]: any[] } = {};
    records.forEach((record) => {
      if (!recordsById[record.id]) recordsById[record.id] = [];
      recordsById[record.id].push(record);
    });

    // Union of ids with new daily rows + ids with a tip, so tips refresh even when the daily row didn't change.
    const ids = Array.from(new Set([...Object.keys(recordsById), ...Object.keys(latestHourlyTips)]));
    if (ids.length === 0) {
      console.log('No new records or tips for PG cache');
      return { updatedIds: 0 };
    }

    for (const id of ids) {
      const idRecords = recordsById[id] ?? [];
      const tip = latestHourlyTips[id];
      const existingRaw = await readPGCacheForId(id);
      const existingCache = stripPGCacheTips(existingRaw);
      const existingRows = getPGCacheRowCount(existingCache);

      if (idRecords.length === 0) {
        // Tip-only refresh: daily backbone unchanged, just re-tip (flows unchanged).
        if (existingRows === 0) continue;
        await storePGCacheForId(id, appendPGCacheTip(existingCache, tip));
        updatedIds++;
        continue;
      }

      const shouldRebuild = !existingRaw || existingRows < MIN_PG_CACHE_ROWS_FOR_INCREMENTAL_REUSE;
      const newData = processRecordsToPGCache(idRecords);
      const incrementallyMerged = mergePGCacheData(existingCache, newData);
      const incrementallyMergedRows = getPGCacheRowCount(incrementallyMerged);
      // Flows depend on the full per-id history; refetch and recompute.
      const fullRecords = await fetchDailyRecordsWithChainsForIdPG(id);

      if (shouldRebuild) {
        const fullData = processRecordsToPGCache(fullRecords);
        const rebuiltRows = getPGCacheRowCount(fullData);
        await storePGCacheForId(id, appendPGCacheTip(smoothPGCacheData(fullData), tip));

        if (rebuiltRows > incrementallyMergedRows) {
          repairEvents.push({
            id,
            reason: existingRaw ? 'suspiciously small existing pg-cache' : 'missing existing pg-cache',
            existingRows,
            rebuiltRows,
            incrementalRows: incrementallyMergedRows,
            ...getRecordRange(fullRecords),
          });
        }
      } else {
        await storePGCacheForId(id, appendPGCacheTip(smoothPGCacheData(incrementallyMerged), tip));
      }
      await storeFlowsForIdFromChainRecords(id, fullRecords);
      updatedIds++;
    }
  } else {
    // Full sync: fetch one ID at a time
    console.log('Full PG cache sync: fetching all records one ID at a time');
    const allIds = await fetchAllDailyIdsPG();
    console.log(`Found ${allIds.length} unique IDs to process`);

    for (let i = 0; i < allIds.length; i++) {
      const id = allIds[i];
      try {
        const records = await fetchDailyRecordsWithChainsForIdPG(id);
        if (records.length === 0) continue;

        const data = processRecordsToPGCache(records);
        await storePGCacheForId(id, appendPGCacheTip(smoothPGCacheData(data), latestHourlyTips[id]));
        await storeFlowsForIdFromChainRecords(id, records);
        updatedIds++;

        if ((i + 1) % 100 === 0) {
          console.log(`PG cache: processed ${i + 1}/${allIds.length} IDs`);
        }
      } catch (e) {
        const message = (e as any)?.message || String(e);
        console.error(`Error processing PG cache for ${id}:`, message);
        processingErrors.push({ id, message });
      }
    }
  }
  
  if (processingErrors.length) {
    await alertPGCacheProcessingErrors(processingErrors);
    throw new Error(`Failed to generate RWA pg-cache for ${processingErrors.length} IDs`);
  }

  // Update sync metadata
  const maxUpdatedAt = await fetchMaxUpdatedAtPG();
  await setPGSyncMetadata({
    lastSyncTimestamp: maxUpdatedAt?.toISOString() || lastSyncTimestamp?.toISOString() || null,
    lastSyncDate: new Date().toISOString(),
    totalIds: updatedIds,
  })

  await alertPGCacheRepairs(repairEvents);

  console.log(`Generated PG cache for ${updatedIds} IDs in ${Date.now() - startTime}ms`);
  return { updatedIds };
}

type AggregateStatsBucket = {
  onChainMcap: number;
  activeMcap: number;
  defiActiveTvl: number;
  assetCount: number;
  assetIssuers: number;
};

// For chain buckets we need issuer identity (not a non-additive count),
// because the frontend may union issuer sets across multiple disjoint buckets.
type AggregateStatsBucketWithIssuers = Omit<AggregateStatsBucket, "assetIssuers"> & {
  assetIssuers: string[];
};

/**
 * Disjoint buckets so the UI can sum without double-counting.
 *
 * Frontend toggle computation:
 * - both off: base
 * - stable on only: base + stablecoinsOnly + stablecoinsAndGovernance
 * - gov on only: base + governanceOnly + stablecoinsAndGovernance
 * - both on: base + stablecoinsOnly + governanceOnly + stablecoinsAndGovernance
 */
type AggregateStatsBucketGroup = {
  base: AggregateStatsBucketWithIssuers;
  stablecoinsOnly: AggregateStatsBucketWithIssuers;
  governanceOnly: AggregateStatsBucketWithIssuers;
  stablecoinsAndGovernance: AggregateStatsBucketWithIssuers;
};

type AggregateStats = {
  totalOnChainMcap: number;
  totalActiveMcap: number;
  totalDefiActiveTvl: number;
  assetCount: number;
  assetIssuers: number;
  byCategory: { [category: string]: AggregateStatsBucketGroup };
  byChain: { [chain: string]: AggregateStatsBucketGroup };
  byPlatform: { [platform: string]: AggregateStatsBucketGroup };
  byAssetGroup: { [assetGroup: string]: AggregateStatsBucketGroup };
};

type AggregateStatsBucketInternal = {
  onChainMcap: number;
  activeMcap: number;
  defiActiveTvl: number;
  assetCount: number;
  assetIssuers: Set<string>;
};

function generateAggregateStats(currentData: any[]): AggregateStats {
  console.log("Generating aggregate stats...");
  const startTime = Date.now();

  const makeAgg = (): AggregateStatsBucketInternal => ({
    onChainMcap: 0,
    activeMcap: 0,
    defiActiveTvl: 0,
    assetCount: 0,
    assetIssuers: new Set<string>(),
  });

  const addToAgg = (
    agg: AggregateStatsBucketInternal,
    delta: { onChainMcap: any; activeMcap: any; defiActiveTvl: any },
    issuer: string | null | undefined
  ) => {
    agg.onChainMcap += toFiniteNumberOrZero(delta.onChainMcap);
    agg.activeMcap += toFiniteNumberOrZero(delta.activeMcap);
    agg.defiActiveTvl += toFiniteNumberOrZero(delta.defiActiveTvl);
    agg.assetCount += 1;
    if (issuer) agg.assetIssuers.add(issuer);
  };

  const sumNumberMap = (obj: any): number => {
    if (!obj || typeof obj !== "object") return 0;
    if (Array.isArray((obj as any).breakdown)) {
      return (obj as any).breakdown.reduce((acc: number, entry: any) => {
        if (!Array.isArray(entry) || entry.length < 2) return acc;
        return acc + toFiniteNumberOrZero(entry[1]);
      }, 0);
    }
    return Object.entries(obj).reduce((acc, [k, v]) => {
      if (k === "total" || k === "breakdown") return acc;
      return acc + toFiniteNumberOrZero(v);
    }, 0);
  };

  const normalizeNumberMap = (obj: any): { [key: string]: number } => {
    const out: { [key: string]: number } = {};
    if (!obj || typeof obj !== "object") return out;

    // Support API-shaped { total, breakdown: [[key, value], ...] }
    if (Array.isArray((obj as any).breakdown)) {
      for (const entry of (obj as any).breakdown) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = String(entry[0]);
        out[key] = (out[key] || 0) + toFiniteNumberOrZero(entry[1]);
      }
      return out;
    }

    // Standard map-shaped { [key]: number }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "total" || k === "breakdown") continue;
      out[k] = (out[k] || 0) + toFiniteNumberOrZero(v);
    }
    return out;
  };

  const normalizeNestedNumberMap = (obj: any): { [chain: string]: { [protocol: string]: number } } => {
    const out: { [chain: string]: { [protocol: string]: number } } = {};
    if (!obj || typeof obj !== "object") return out;

    // If this is the chain-filtered API output { total, breakdown }, we can't recover the chain key here.
    if (Array.isArray((obj as any).breakdown)) return out;

    for (const [chain, protocols] of Object.entries(obj)) {
      if (!protocols || typeof protocols !== "object") continue;
      const inner: { [protocol: string]: number } = {};
      for (const [p, v] of Object.entries(protocols as any)) {
        inner[p] = (inner[p] || 0) + toFiniteNumberOrZero(v);
      }
      out[chain] = inner;
    }
    return out;
  };

  const sumProtocolMap = (obj: any): number => {
    if (!obj || typeof obj !== "object") return 0;
    let total = 0;
    for (const v of Object.values(obj as any)) {
      total += toFiniteNumberOrZero(v);
    }
    return total;
  };

  type BucketGroupInternal = {
    base: AggregateStatsBucketInternal;
    stablecoinsOnly: AggregateStatsBucketInternal;
    governanceOnly: AggregateStatsBucketInternal;
    stablecoinsAndGovernance: AggregateStatsBucketInternal;
  };

  const makeBucketGroup = (): BucketGroupInternal => ({
    base: makeAgg(),
    stablecoinsOnly: makeAgg(),
    governanceOnly: makeAgg(),
    stablecoinsAndGovernance: makeAgg(),
  });

  const addToBucketGroup = (
    group: BucketGroupInternal,
    delta: { onChainMcap: any; activeMcap: any; defiActiveTvl: any },
    issuer: string | null | undefined,
    stablecoin: boolean,
    governance: boolean,
  ) => {
    if (stablecoin && governance) addToAgg(group.stablecoinsAndGovernance, delta, issuer);
    else if (stablecoin) addToAgg(group.stablecoinsOnly, delta, issuer);
    else if (governance) addToAgg(group.governanceOnly, delta, issuer);
    else addToAgg(group.base, delta, issuer);
  };

  const byCategory: { [category: string]: BucketGroupInternal } = {};
  const byChain: { [chain: string]: BucketGroupInternal } = {};
  const byPlatform: { [platform: string]: BucketGroupInternal } = {};
  const byAssetGroup: { [assetGroup: string]: BucketGroupInternal } = {};

  let totalOnChainMcap = 0;
  let totalActiveMcap = 0;
  let totalDefiActiveTvl = 0;
  let assetCount = 0;
  const allIssuers = new Set<string>();

  for (const item of currentData || []) {
    if (!item || typeof item !== "object") continue;

    const assetType = typeof item.type === "string" ? item.type.trim() : "";
    const isWrapper = assetType.toLowerCase() === "wrapper";

    const issuer: string | null = typeof item.issuer === "string" && item.issuer.trim() ? item.issuer.trim() : null;

    const stablecoin = item.stablecoin === true;
    const governance = item.governance === true;

    const onChainMcapByChain = normalizeNumberMap(item.onChainMcap);
    const activeMcapByChain = normalizeNumberMap(item.activeMcap);
    const defiActiveTvlByChain = normalizeNestedNumberMap(item.defiActiveTvl);

    const assetOnChainTotal = sumNumberMap(onChainMcapByChain);
    const assetActiveTotal = sumNumberMap(activeMcapByChain);
    const assetDefiActiveTotal = Object.values(defiActiveTvlByChain).reduce(
      (acc, protocols) => acc + sumProtocolMap(protocols),
      0
    );

    const assetDelta = { onChainMcap: assetOnChainTotal, activeMcap: assetActiveTotal, defiActiveTvl: assetDefiActiveTotal };

    // Wrappers are excluded from global totals and non-platform aggregations to avoid double-counting,
    // but included in platform aggregation so platforms show their full value including wrappers.
    if (!isWrapper) {
      assetCount += 1;
      if (issuer) allIssuers.add(issuer);

      totalOnChainMcap += assetOnChainTotal;
      totalActiveMcap += assetActiveTotal;
      totalDefiActiveTvl += assetDefiActiveTotal;

      // Category aggregation uses only the primary category to avoid double-counting.
      const categories: string[] = Array.isArray(item.category) ? item.category.filter(Boolean) : [];
      const primaryCategory = categories[0];
      if (primaryCategory) {
        if (!byCategory[primaryCategory]) byCategory[primaryCategory] = makeBucketGroup();
        addToBucketGroup(byCategory[primaryCategory], assetDelta, issuer, stablecoin, governance);
      }

      // AssetGroup aggregation
      const assetGroup =
        typeof item.assetGroup === "string" && item.assetGroup.trim() ? item.assetGroup.trim() : null;
      if (assetGroup) {
        if (!byAssetGroup[assetGroup]) byAssetGroup[assetGroup] = makeBucketGroup();
        addToBucketGroup(byAssetGroup[assetGroup], assetDelta, issuer, stablecoin, governance);
      }

      // Chain aggregation (per-chain values, not asset totals)
      const chains = new Set<string>([
        ...Object.keys(onChainMcapByChain || {}),
        ...Object.keys(activeMcapByChain || {}),
        ...Object.keys(defiActiveTvlByChain || {}),
      ]);

      for (const chain of chains) {
        if (!chain) continue;
        if (!byChain[chain]) byChain[chain] = makeBucketGroup();
        const chainDelta = {
          onChainMcap: toFiniteNumberOrZero(onChainMcapByChain?.[chain]),
          activeMcap: toFiniteNumberOrZero(activeMcapByChain?.[chain]),
          defiActiveTvl: sumProtocolMap(defiActiveTvlByChain?.[chain]),
        };
        addToBucketGroup(byChain[chain], chainDelta, issuer, stablecoin, governance);
      }
    }

    // Platform aggregation includes wrappers (ONLY when asset has a valid parentPlatform; never synthesize "Unknown")
    const platform =
      typeof item.parentPlatform === "string" && item.parentPlatform.trim() ? item.parentPlatform.trim() : null;
    if (platform && platform !== "Unknown") {
      if (!byPlatform[platform]) byPlatform[platform] = makeBucketGroup();
      addToBucketGroup(byPlatform[platform], assetDelta, issuer, stablecoin, governance);
    }
  }

  const toAggOut = (a: AggregateStatsBucketInternal): AggregateStatsBucketWithIssuers => ({
    onChainMcap: a.onChainMcap,
    activeMcap: a.activeMcap,
    defiActiveTvl: a.defiActiveTvl,
    assetCount: a.assetCount,
    assetIssuers: Array.from(a.assetIssuers).sort(),
  });

  const serializeBucketGroup = (g: BucketGroupInternal): AggregateStatsBucketGroup => ({
    base: toAggOut(g.base),
    stablecoinsOnly: toAggOut(g.stablecoinsOnly),
    governanceOnly: toAggOut(g.governanceOnly),
    stablecoinsAndGovernance: toAggOut(g.stablecoinsAndGovernance),
  });

  const outByCategory: { [k: string]: AggregateStatsBucketGroup } = {};
  for (const k in byCategory) outByCategory[k] = serializeBucketGroup(byCategory[k]);

  const outByAssetGroup: { [k: string]: AggregateStatsBucketGroup } = {};
  for (const k in byAssetGroup) outByAssetGroup[k] = serializeBucketGroup(byAssetGroup[k]);

  const outByPlatform: { [k: string]: AggregateStatsBucketGroup } = {};
  for (const k in byPlatform) outByPlatform[k] = serializeBucketGroup(byPlatform[k]);

  const outByChain: { [k: string]: AggregateStatsBucketGroup } = {};
  for (const k in byChain) outByChain[k] = serializeBucketGroup(byChain[k]);

  console.log(`Generated aggregate stats in ${Date.now() - startTime}ms`);

  return {
    totalOnChainMcap,
    totalActiveMcap,
    totalDefiActiveTvl,
    assetCount,
    assetIssuers: allIssuers.size,
    byCategory: outByCategory,
    byChain: outByChain,
    byPlatform: outByPlatform,
    byAssetGroup: outByAssetGroup,
  };
}


function generateList(currentData: any[], stats: AggregateStats): {
  canonicalMarketIds: string[];
  platforms: string[];
  chains: string[];
  categories: string[];
  assetGroups: string[];
  idMap: { [name: string]: string };
} {
  console.log('Generating list data...');
  const startTime = Date.now();

  const canonicalMarketIdMcap: { [canonicalMarketId: string]: number } = {};
  const idMap: { [canonicalMarketId: string]: string } = {};

  for (const item of currentData) {
    const assetType = typeof item.type === "string" ? item.type.trim() : "";
    // if (assetType.toLowerCase() === "wrapper") continue;

    let assetMcap = 0;
    const mcapObj = item.onChainMcap;
    if (mcapObj && typeof mcapObj === 'object') {
      if (Array.isArray(mcapObj.breakdown)) {
        for (const entry of mcapObj.breakdown) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          assetMcap += toFiniteNumberOrZero(entry[1]);
        }
      } else {
        for (const k in mcapObj) {
          if (k === "total" || k === "breakdown") continue;
          assetMcap += toFiniteNumberOrZero(mcapObj[k]);
        }
      }
    }

    if (item.canonicalMarketId) {
      canonicalMarketIdMcap[item.canonicalMarketId] = (canonicalMarketIdMcap[item.canonicalMarketId] || 0) + assetMcap;
      idMap[item.canonicalMarketId] = item.id;
    }
  }

  const canonicalMarketIdPairs: [string, number][] = [];
  for (const k in canonicalMarketIdMcap) canonicalMarketIdPairs.push([k, canonicalMarketIdMcap[k]]);
  const canonicalMarketIdsSorted = canonicalMarketIdPairs.sort((a, b) => b[1] - a[1]).map(([k]) => k);

  // Chains: sorted by base onChainMcap only (excludes stablecoins & governance tokens)
  const chainPairs: [string, number][] = [];
  for (const k in stats.byChain) chainPairs.push([k, stats.byChain[k].base.onChainMcap]);
  const chainsSorted = chainPairs.sort((a, b) => b[1] - a[1]).map(([k]) => k);

  // Platforms / categories / assetGroups: same as chains — base onChainMcap only
  const platformPairs: [string, number][] = [];
  for (const k in stats.byPlatform) platformPairs.push([k, stats.byPlatform[k].base.onChainMcap]);
  const platformsSorted = platformPairs.sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const categoryPairs: [string, number][] = [];
  for (const k in stats.byCategory) categoryPairs.push([k, stats.byCategory[k].base.onChainMcap]);
  const categoriesSorted = categoryPairs.sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const assetGroupPairs: [string, number][] = [];
  for (const k in stats.byAssetGroup) assetGroupPairs.push([k, stats.byAssetGroup[k].base.onChainMcap]);
  const assetGroupsSorted = assetGroupPairs.sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const list = {
    canonicalMarketIds: canonicalMarketIdsSorted,
    platforms: platformsSorted,
    chains: chainsSorted,
    categories: categoriesSorted,
    assetGroups: assetGroupsSorted,
    idMap,
  };

  console.log(`Generated list data in ${Date.now() - startTime}ms`);
  return list;
}

interface HistoricalDataPoint {
  timestamp: number;
  onChainMcap: number;
  activeMcap: number;
  defiActiveTvl: number;
}

interface HistoricalBreakdownDataPoint {
  onChainMcap: Record<string, Record<string, number>>;
  activeMcap: Record<string, Record<string, number>>;
  defiActiveTvl: Record<string, Record<string, number>>;
  assetKeysByTimestamp?: Record<string, Record<string, true>>;
}

interface HistoricalDataPointAssetTypes {
  base: HistoricalBreakdownDataPoint;
  includeStablecoin: HistoricalBreakdownDataPoint; // base + stablecoin
  includeGovernance: HistoricalBreakdownDataPoint; // base + governance
  all: HistoricalBreakdownDataPoint; // base + stablecoin + governance
}

async function alertSuspiciousRwaHistoricalCharts(
  allChainAssetBreakdown: HistoricalBreakdownDataPoint | undefined,
  metadata: RWAMetadata[]
): Promise<void> {
  const options = {
    minSinglePointMcap: RWA_CHART_ALERT_MIN_SINGLE_POINT_MCAP,
    minDayDelta: RWA_CHART_ALERT_MIN_DAY_DELTA,
    minDayRatio: RWA_CHART_ALERT_MIN_DAY_RATIO,
    maxItems: RWA_CHART_ALERT_MAX_ITEMS,
    lookbackDays: RWA_CHART_ALERT_LOOKBACK_DAYS,
  };
  const report = getSuspiciousRwaHistoricalChartReport(allChainAssetBreakdown, metadata, options);
  if (!hasSuspiciousRwaHistoricalChartReport(report)) return;

  const message = formatRwaHistoricalChartGuardReport(report, metadata, options);
  await sendThrottledRwaHistoricalChartGuardAlert(message);
  if (RWA_CHART_ALERT_FAIL_ON_SUSPICIOUS) {
    throw new Error('Suspicious RWA historical chart shape detected; refusing to publish aggregate historical chart cache');
  }
}

export async function generateAggregatedHistoricalCharts(metadata: RWAMetadata[]): Promise<void> {
  console.log('Generating aggregated historical charts...');
  const startTime = Date.now();

  // Aggregation maps: key -> timestamp -> values
  const byChain: { [chain: string]: { [timestamp: number]: HistoricalDataPoint } } = {};
  const byCategory: { [category: string]: { [timestamp: number]: HistoricalDataPoint } } = {};
  const byPlatform: { [platform: string]: { [timestamp: number]: HistoricalDataPoint } } = {};
  const byAssetGroup: { [assetGroup: string]: { [timestamp: number]: HistoricalDataPoint } } = {};

  // breakdown by asset
  const byChainTickerBreakdown: { [category: string]: HistoricalBreakdownDataPoint } = {};
  const byCategoryTickerBreakdown: { [category: string]: HistoricalBreakdownDataPoint } = {};
  const byPlatformTickerBreakdown: { [category: string]: HistoricalBreakdownDataPoint } = {};
  const byAssetGroupTickerBreakdown: { [category: string]: HistoricalBreakdownDataPoint } = {};

  // charts breakdown
  // keys: onChainMcap, activeMcap, defiActiveTvl
  // assetType: base, stblecoin, governance

  // timestamp => assetType => key => chain
  const chainBreakdownAndAssetTypes: { [timestamp: number]: HistoricalDataPointAssetTypes } = {};
  // timestamp => assetType => key => category
  const categoryBreakdownAndAssetTypes: { [timestamp: number]: HistoricalDataPointAssetTypes } = {};
  // timestamp => assetType => key => platform
  const platformBreakdownAndAssetTypes: { [timestamp: number]: HistoricalDataPointAssetTypes } = {};
  // timestamp => assetType => key => assetGroup
  const assetGroupBreakdownAndAssetTypes: { [timestamp: number]: HistoricalDataPointAssetTypes } = {};
  const chainBreakdownStartedItems = new Set<string>();
  const categoryBreakdownStartedItems = new Set<string>();
  const platformBreakdownStartedItems = new Set<string>();
  const assetGroupBreakdownStartedItems = new Set<string>();

  function ensureDataPoint(
    map: { [key: string]: { [timestamp: number]: HistoricalDataPoint } },
    key: string,
    timestamp: number
  ): HistoricalDataPoint {
    if (!map[key]) map[key] = {};
    if (!map[key][timestamp]) map[key][timestamp] = { timestamp, onChainMcap: 0, activeMcap: 0, defiActiveTvl: 0 };
    return map[key][timestamp];
  }

  function ensureBreakdownDataPoint(
    map: { [category: string]: HistoricalBreakdownDataPoint },
    key: string,
    timestamp: number,
    assetKey: string
  ): HistoricalBreakdownDataPoint {
    const timestampKey = String(timestamp);
    if (!map[key]) {
      map[key] = {
        onChainMcap: {},
        activeMcap: {},
        defiActiveTvl: {},
        assetKeysByTimestamp: RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES ? undefined : {},
      };
    }

    const breakdown = map[key];
    breakdown.onChainMcap[timestampKey] = breakdown.onChainMcap[timestampKey] || {};
    breakdown.activeMcap[timestampKey] = breakdown.activeMcap[timestampKey] || {};
    breakdown.defiActiveTvl[timestampKey] = breakdown.defiActiveTvl[timestampKey] || {};
    if (!RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES) {
      breakdown.assetKeysByTimestamp![timestampKey] = breakdown.assetKeysByTimestamp![timestampKey] || {};
      breakdown.assetKeysByTimestamp![timestampKey][assetKey] = true;
    }

    return breakdown;
  }

  function addBreakdownValue(
    breakdown: HistoricalBreakdownDataPoint,
    metric: 'onChainMcap' | 'activeMcap' | 'defiActiveTvl',
    timestamp: number,
    assetKey: string,
    value: number
  ) {
    const numericValue = toFiniteNumberOrZero(value);
    if (numericValue === 0) return;
    const timestampKey = String(timestamp);
    breakdown[metric][timestampKey][assetKey] = (breakdown[metric][timestampKey][assetKey] || 0) + numericValue;
  }

  function _updateBreakdownAndAssetTypes(map: { [timestamp: number]: HistoricalDataPointAssetTypes }, timestamp: number, assetType: string, key: string, chain: string, value: number) {
    map[timestamp] = map[timestamp] || {
      base: { onChainMcap: {}, activeMcap: {}, defiActiveTvl: {} },
      includeStablecoin: { onChainMcap: {}, activeMcap: {}, defiActiveTvl: {} },
      includeGovernance: { onChainMcap: {}, activeMcap: {}, defiActiveTvl: {} },
      all: { onChainMcap: {}, activeMcap: {}, defiActiveTvl: {} },
    };
    (map[timestamp] as any)[assetType][key][chain] = (map[timestamp] as any)[assetType][key][chain] || 0;
    (map[timestamp] as any)[assetType][key][chain] += value;
  }
  
  function updateBreakdownAndAssetTypes(map: { [timestamp: number]: HistoricalDataPointAssetTypes }, m: any, timestamp: number, data: any, startedItems: Set<string>) {
    function _addToBreakdownItem(map: { [timestamp: number]: HistoricalDataPointAssetTypes }, timestamp: number, assetType: string, itemKey: string, itemValues: any) {
      if (!shouldEmitRwaBreakdownItem(startedItems, `${assetType}:${itemKey}`, itemValues as any)) return;
      _updateBreakdownAndAssetTypes(map, timestamp, assetType, "onChainMcap", itemKey, toFiniteNumberOrZero((itemValues as any)?.onChainMcap));
      _updateBreakdownAndAssetTypes(map, timestamp, assetType, "activeMcap", itemKey, toFiniteNumberOrZero((itemValues as any)?.activeMcap));
      _updateBreakdownAndAssetTypes(map, timestamp, assetType, "defiActiveTvl", itemKey, toFiniteNumberOrZero((itemValues as any)?.defiActiveTvl));
    }
    
    for (const [itemKey, itemValues] of Object.entries(data || {})) {
      if (m.data.stablecoin && m.data.governance) {
        // add to includeStablecoin, includeGovernance, and all
        _addToBreakdownItem(map, timestamp, "includeStablecoin", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "includeGovernance", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "all", itemKey, itemValues)
      } else if (m.data.stablecoin) {
        // add to includeStablecoin and all
        _addToBreakdownItem(map, timestamp, "includeStablecoin", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "all", itemKey, itemValues)
      } else if (m.data.governance) {
        // add to includeGovernance and all
        _addToBreakdownItem(map, timestamp, "includeGovernance", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "all", itemKey, itemValues)
      } else {
        // add to base, includeStablecoin, includeGovernance, and all
        _addToBreakdownItem(map, timestamp, "base", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "includeStablecoin", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "includeGovernance", itemKey, itemValues)
        _addToBreakdownItem(map, timestamp, "all", itemKey, itemValues)
      }
    }
  }

  // Process each asset's pg-cache for chain breakdown
  let processedCount = 0;
  for (const m of metadata) {
    const canonicalMarketId = m.data.canonicalMarketId;
    if (!canonicalMarketId) continue;

    // Strip tips: aggregates bucket by exact timestamp, so intraday tips would fragment the tail.
    const pgCacheRaw = await readPGCacheForId(m.id);
    if (!pgCacheRaw) continue;
    const pgCache = stripPGCacheTips(pgCacheRaw);

    const categories = Array.isArray(m.data.category) ? m.data.category.filter(Boolean) : [];
    const primaryCategory = categories[0];
    const categoryAssetBreakdownCategories = new Set(categories);
    const platform = m.data.parentPlatform;
    const assetGroup = typeof m.data.assetGroup === "string" && m.data.assetGroup.trim() ? m.data.assetGroup.trim() : null;

    for (const [timestampStr, record] of Object.entries(pgCache)) {
      const timestamp = Number(timestampStr);
      // Defensive: pg-cache *should* be numeric, but if any legacy cache has strings
      // we must coerce before using `+=` (otherwise JS turns it into string concatenation).
      const {
        onChainMcap: rawTotalOnChainMcap,
        activeMcap: rawTotalActiveMcap,
        defiActiveTvl: rawTotalTvl,
        chains,
      } = record as any;

      const totalOnChainMcap = toFiniteNumberOrZero(rawTotalOnChainMcap);
      const totalActiveMcap = toFiniteNumberOrZero(rawTotalActiveMcap);
      const totalTvl = toFiniteNumberOrZero(rawTotalTvl);

      // Aggregate by individual chains (using chain keys)
      for (const [chainKey, chainData] of Object.entries(chains || {})) {
        const chainOnChainMcap = toFiniteNumberOrZero((chainData as any)?.onChainMcap);
        const chainActiveMcap = toFiniteNumberOrZero((chainData as any)?.activeMcap);
        const chainTvl = toFiniteNumberOrZero((chainData as any)?.defiActiveTvl);
        const chainDp = ensureDataPoint(byChain, chainKey, timestamp);
        chainDp.onChainMcap += chainOnChainMcap;
        chainDp.activeMcap += chainActiveMcap;
        chainDp.defiActiveTvl += chainTvl;
        
        const dpa = ensureBreakdownDataPoint(byChainTickerBreakdown, chainKey, timestamp, canonicalMarketId);
        addBreakdownValue(dpa, 'onChainMcap', timestamp, canonicalMarketId, chainOnChainMcap);
        addBreakdownValue(dpa, 'activeMcap', timestamp, canonicalMarketId, chainActiveMcap);
        addBreakdownValue(dpa, 'defiActiveTvl', timestamp, canonicalMarketId, chainTvl);
      }

      // Aggregate to "All"
      const allDp = ensureDataPoint(byChain, 'all', timestamp);
      allDp.onChainMcap += totalOnChainMcap;
      allDp.activeMcap += totalActiveMcap;
      allDp.defiActiveTvl += totalTvl;
      
      const allDpa = ensureBreakdownDataPoint(byChainTickerBreakdown, 'all', timestamp, canonicalMarketId);
      addBreakdownValue(allDpa, 'onChainMcap', timestamp, canonicalMarketId, totalOnChainMcap);
      addBreakdownValue(allDpa, 'activeMcap', timestamp, canonicalMarketId, totalActiveMcap);
      addBreakdownValue(allDpa, 'defiActiveTvl', timestamp, canonicalMarketId, totalTvl);

      // Aggregate category totals using only the primary category to avoid double-counting.
      const categoryItems: Record<string, any> = {};
      if (primaryCategory) {
        const dp = ensureDataPoint(byCategory, primaryCategory, timestamp);
        dp.onChainMcap += totalOnChainMcap;
        dp.activeMcap += totalActiveMcap;
        dp.defiActiveTvl += totalTvl;

        categoryItems[primaryCategory] = {
          onChainMcap: totalOnChainMcap,
          activeMcap: totalActiveMcap,
          defiActiveTvl: totalTvl,
        };
      }

      // Category asset-breakdown files power category detail charts, so include
      // every asset category rather than only the primary aggregate bucket.
      for (const category of categoryAssetBreakdownCategories) {
        const dpa = ensureBreakdownDataPoint(byCategoryTickerBreakdown, category as string, timestamp, canonicalMarketId);
        addBreakdownValue(dpa, 'onChainMcap', timestamp, canonicalMarketId, totalOnChainMcap);
        addBreakdownValue(dpa, 'activeMcap', timestamp, canonicalMarketId, totalActiveMcap);
        addBreakdownValue(dpa, 'defiActiveTvl', timestamp, canonicalMarketId, totalTvl);
      }

      // Aggregate by platform
      const platformItems: Record<string, any> = {};
      if (platform) {
        const dp = ensureDataPoint(byPlatform, platform, timestamp);
        dp.onChainMcap += totalOnChainMcap;
        dp.activeMcap += totalActiveMcap;
        dp.defiActiveTvl += totalTvl;
        
        const dpa = ensureBreakdownDataPoint(byPlatformTickerBreakdown, platform, timestamp, canonicalMarketId);
        addBreakdownValue(dpa, 'onChainMcap', timestamp, canonicalMarketId, totalOnChainMcap);
        addBreakdownValue(dpa, 'activeMcap', timestamp, canonicalMarketId, totalActiveMcap);
        addBreakdownValue(dpa, 'defiActiveTvl', timestamp, canonicalMarketId, totalTvl);
        
        platformItems[platform] = { onChainMcap: 0, activeMcap: 0, defiActiveTvl: 0 };
        platformItems[platform].onChainMcap += totalOnChainMcap;
        platformItems[platform].activeMcap += totalActiveMcap;
        platformItems[platform].defiActiveTvl += totalTvl;
      }
      
      // Aggregate by assetGroup
      const assetGroupItems: Record<string, any> = {};
      if (assetGroup) {
        const dp = ensureDataPoint(byAssetGroup, assetGroup, timestamp);
        dp.onChainMcap += totalOnChainMcap;
        dp.activeMcap += totalActiveMcap;
        dp.defiActiveTvl += totalTvl;

        const dpa = ensureBreakdownDataPoint(byAssetGroupTickerBreakdown, assetGroup, timestamp, canonicalMarketId);
        addBreakdownValue(dpa, 'onChainMcap', timestamp, canonicalMarketId, totalOnChainMcap);
        addBreakdownValue(dpa, 'activeMcap', timestamp, canonicalMarketId, totalActiveMcap);
        addBreakdownValue(dpa, 'defiActiveTvl', timestamp, canonicalMarketId, totalTvl);

        assetGroupItems[assetGroup] = { onChainMcap: 0, activeMcap: 0, defiActiveTvl: 0 };
        assetGroupItems[assetGroup].onChainMcap += totalOnChainMcap;
        assetGroupItems[assetGroup].activeMcap += totalActiveMcap;
        assetGroupItems[assetGroup].defiActiveTvl += totalTvl;
      }

      // update chart breakdown
      updateBreakdownAndAssetTypes(chainBreakdownAndAssetTypes, m, timestamp, chains, chainBreakdownStartedItems);
      updateBreakdownAndAssetTypes(categoryBreakdownAndAssetTypes, m, timestamp, categoryItems, categoryBreakdownStartedItems);
      updateBreakdownAndAssetTypes(platformBreakdownAndAssetTypes, m, timestamp, platformItems, platformBreakdownStartedItems);
      updateBreakdownAndAssetTypes(assetGroupBreakdownAndAssetTypes, m, timestamp, assetGroupItems, assetGroupBreakdownStartedItems);
    }
    processedCount++;
  }

  // Convert to sorted arrays and store
  function toSortedArray(map: { [timestamp: number]: HistoricalDataPoint }): HistoricalDataPoint[] {
    return Object.values(map)
      .map((dp) => ({
        timestamp: toFiniteNumberOrZero(dp.timestamp),
        onChainMcap: toFiniteNumberOrZero(dp.onChainMcap),
        activeMcap: toFiniteNumberOrZero(dp.activeMcap),
        defiActiveTvl: toFiniteNumberOrZero(dp.defiActiveTvl),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  
  function getSortedBreakdownTimestamps(
    metricMap: Record<string, Record<string, number>>,
    assetKeysByTimestamp?: Record<string, Record<string, true>>
  ): string[] {
    const timestamps = new Set<string>(Object.keys(metricMap));
    for (const timestamp of Object.keys(assetKeysByTimestamp || {})) timestamps.add(timestamp);
    return Array.from(timestamps).sort((a, b) => toFiniteNumberOrZero(a) - toFiniteNumberOrZero(b));
  }

  function getBreakdownAssetKeys(valueMap: Record<string, number>, assetKeyMap?: Record<string, true>): string[] {
    const keys = Object.keys(assetKeyMap || valueMap);
    if (assetKeyMap) {
      for (const key of Object.keys(valueMap)) {
        if (!assetKeyMap[key]) keys.push(key);
      }
    }
    return keys;
  }

  function getNonZeroBreakdownAssetKeys(valueMap: Record<string, number>): string[] {
    return Object.keys(valueMap).filter((assetKey) => toFiniteNumberOrZero(valueMap[assetKey]) !== 0);
  }

  async function writeSortedBreakdownRows(
    writeChunk: (chunk: string) => Promise<void>,
    map: Record<string, Record<string, number>>,
    assetKeysByTimestamp?: Record<string, Record<string, true>>
  ): Promise<void> {
    const timestamps = RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES
      ? Object.keys(map)
          .filter((timestamp) => getNonZeroBreakdownAssetKeys(map[timestamp] || {}).length > 0)
          .sort((a, b) => toFiniteNumberOrZero(a) - toFiniteNumberOrZero(b))
      : getSortedBreakdownTimestamps(map, assetKeysByTimestamp);
    await writeChunk('[');
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const valueMap = map[timestamp] || {};
      const parts = [`{"timestamp":${JSON.stringify(toFiniteNumberOrZero(timestamp))}`];
      const assetKeys = RWA_OMIT_ZERO_ASSET_BREAKDOWN_VALUES
        ? getNonZeroBreakdownAssetKeys(valueMap)
        : getBreakdownAssetKeys(valueMap, assetKeysByTimestamp?.[timestamp]);
      for (const assetKey of assetKeys) {
        parts.push(',', JSON.stringify(assetKey), ':', JSON.stringify(toFiniteNumberOrZero(valueMap[assetKey])));
      }
      parts.push('}');
      if (i > 0) await writeChunk(',');
      await writeChunk(parts.join(''));
    }
    await writeChunk(']');
  }

  async function storeAssetBreakdownRouteData(subPath: string, dataMap: HistoricalBreakdownDataPoint): Promise<void> {
    await storeRouteDataWithWriter(subPath, async (writeChunk) => {
      await writeChunk('{"onChainMcap":');
      await writeSortedBreakdownRows(writeChunk, dataMap.onChainMcap, dataMap.assetKeysByTimestamp);
      await writeChunk(',"activeMcap":');
      await writeSortedBreakdownRows(writeChunk, dataMap.activeMcap, dataMap.assetKeysByTimestamp);
      await writeChunk(',"defiActiveTvl":');
      await writeSortedBreakdownRows(writeChunk, dataMap.defiActiveTvl, dataMap.assetKeysByTimestamp);
      await writeChunk('}');
    });
  }

  // Detect slug collisions: if two raw keys produce the same slug, the second
  // storeRouteData call silently overwrites the first, losing data. Metadata
  // normalization should prevent this, but log a warning as a safety net.
  function warnSlugCollisions(label: string, rawKeys: string[], toSlug: (k: string) => string) {
    const seen: { [slug: string]: string } = {};
    for (const raw of rawKeys) {
      const slug = toSlug(raw);
      if (seen[slug] && seen[slug] !== raw) {
        console.error(`[WARN] Slug collision in ${label}: "${seen[slug]}" and "${raw}" both map to "${slug}". Data will be overwritten.`);
      }
      seen[slug] = raw;
    }
  }

  const chainSlug = (k: string) => rwaSlug(getChainLabelFromKey(k));
  warnSlugCollisions('byChain', Object.keys(byChain), chainSlug);
  warnSlugCollisions('byCategory', Object.keys(byCategory), rwaSlug);
  warnSlugCollisions('byCategoryTickerBreakdown', Object.keys(byCategoryTickerBreakdown), rwaSlug);
  warnSlugCollisions('byPlatform', Object.keys(byPlatform), rwaSlug);
  warnSlugCollisions('byAssetGroup', Object.keys(byAssetGroup), rwaSlug);

  await alertSuspiciousRwaHistoricalCharts(byChainTickerBreakdown['all'], metadata);

  // Store chain charts (includes "All" and individual chains)
  for (const [chain, timestampMap] of Object.entries(byChain)) {
    const chainLabel = getChainLabelFromKey(chain);
    const key = rwaSlug(chainLabel);
    await storeRouteData(`charts/chain/${key}.json`, toSortedArray(timestampMap));
  }
  
  // Store chain charts - breakdown by asset key
  for (const [chain, dataMap] of Object.entries(byChainTickerBreakdown)) {
    const chainLabel = getChainLabelFromKey(chain);
    const key = rwaSlug(chainLabel);
    await storeAssetBreakdownRouteData(`charts/chain-asset-breakdown/${key}.json`, dataMap);
  }

  // Store chain charts - chain breakdown by asset types
  const rawChainBreakdownAndAssetTypes = toTimeseriesBreakdownChart(chainBreakdownAndAssetTypes, true);
  for (const [rawKey, rawData] of Object.entries(rawChainBreakdownAndAssetTypes)) {
    await storeRouteData(`charts/chain-breakdown/${rawKey}.json`, (rawData as Array<any>).sort((a, b) => a.timestamp > b.timestamp ? 1 : -1));
  }

  // Store category charts
  for (const [category, timestampMap] of Object.entries(byCategory)) {
    const key = rwaSlug(category);
    await storeRouteData(`charts/category/${key}.json`, toSortedArray(timestampMap));
  }
  
  // Store category charts - breakdown by asset key
  for (const [category, dataMap] of Object.entries(byCategoryTickerBreakdown)) {
    const key = rwaSlug(category);
    await storeAssetBreakdownRouteData(`charts/category-asset-breakdown/${key}.json`, dataMap);
  }
  
  // Store category charts - category breakdown by asset types
  const rawCategoryBreakdownAndAssetTypes = toTimeseriesBreakdownChart(categoryBreakdownAndAssetTypes);
  for (const [rawKey, rawData] of Object.entries(rawCategoryBreakdownAndAssetTypes)) {
    await storeRouteData(`charts/category-breakdown/${rawKey}.json`, (rawData as Array<any>).sort((a, b) => a.timestamp > b.timestamp ? 1 : -1));
  }

  // Store platform charts
  for (const [platform, timestampMap] of Object.entries(byPlatform)) {
    const key = rwaSlug(platform);
    await storeRouteData(`charts/platform/${key}.json`, toSortedArray(timestampMap));
  }
  
  // Store platform charts - breakdown by asset key
  for (const [platform, dataMap] of Object.entries(byPlatformTickerBreakdown)) {
    const key = rwaSlug(platform);
    await storeAssetBreakdownRouteData(`charts/platform-asset-breakdown/${key}.json`, dataMap);
  }
  
  // Store platform charts - platform breakdown by asset types
  const rawPlatformBreakdownAndAssetTypes = toTimeseriesBreakdownChart(platformBreakdownAndAssetTypes);
  for (const [rawKey, rawData] of Object.entries(rawPlatformBreakdownAndAssetTypes)) {
    await storeRouteData(`charts/platform-breakdown/${rawKey}.json`, (rawData as Array<any>).sort((a, b) => a.timestamp > b.timestamp ? 1 : -1));
  }

  // Store assetGroup charts
  for (const [ag, timestampMap] of Object.entries(byAssetGroup)) {
    const key = rwaSlug(ag);
    await storeRouteData(`charts/assetGroup/${key}.json`, toSortedArray(timestampMap));
  }

  // Store assetGroup charts - breakdown by asset key
  for (const [ag, dataMap] of Object.entries(byAssetGroupTickerBreakdown)) {
    const key = rwaSlug(ag);
    await storeAssetBreakdownRouteData(`charts/assetGroup-asset-breakdown/${key}.json`, dataMap);
  }

  // Store assetGroup breakdown by asset types
  const rawAssetGroupBreakdownAndAssetTypes = toTimeseriesBreakdownChart(assetGroupBreakdownAndAssetTypes);
  for (const [rawKey, rawData] of Object.entries(rawAssetGroupBreakdownAndAssetTypes)) {
    await storeRouteData(`charts/assetGroup-breakdown/${rawKey}.json`, (rawData as Array<any>).sort((a, b) => a.timestamp > b.timestamp ? 1 : -1));
  }

  console.log(`Generated aggregated historical charts in ${Date.now() - startTime}ms`);
  console.log(`  Processed ${processedCount} assets. Chains: ${Object.keys(byChain).length}, Categories: ${Object.keys(byCategory).length}, Platforms: ${Object.keys(byPlatform).length}, AssetGroups: ${Object.keys(byAssetGroup).length}`);
}

// Pre-compute aggregated net-flow series (overview / group / platform / chain) +
// windowed leaderboard, like generateAggregatedHistoricalCharts does for mcap. Runs
// after generatePGCache so per-asset flow files + pg-cache exist on disk.
// Chain agg sums netFlowByChain AS-IS: bridges show as outflow+inflow per chain
// (nets to 0 in asset/group/platform totals; per-chain = "supply change by chain").
export async function generateAggregatedFlows(metadata: RWAMetadata[]): Promise<void> {
  console.log('Generating aggregated flows...');
  const startTime = Date.now();

  type AssetFlows = {
    id: string;
    label: string;            // canonicalMarketId
    assetGroup: string | null;
    platform: string | null;
    series: FlowPoint[];
    latestMcap: number;       // for flow-intensity
    latestMcapByChain: { [chainLabel: string]: number };
    chains: Set<string>;
  };

  const assets: AssetFlows[] = [];
  for (const m of metadata) {
    const label = m.data.canonicalMarketId;
    if (!label) continue;
    if (FLOWS_HIDDEN_IDS.has(String(m.id))) continue;

    const series = (await readFlowsForId(m.id)) as FlowPoint[] | null;
    if (!series || series.length === 0) continue;

    let latestMcap = 0;
    const latestMcapByChain: { [c: string]: number } = {};
    const pgCache = await readPGCacheForId(m.id);
    if (pgCache) {
      const timestamps = Object.keys(pgCache).map(Number);
      if (timestamps.length > 0) {
        const lastTs = Math.max(...timestamps);
        const rec = pgCache[lastTs] as any;
        latestMcap = toFiniteNumberOrZero(rec?.onChainMcap);
        for (const [chainKey, chainData] of Object.entries(rec?.chains || {})) {
          latestMcapByChain[getChainLabelFromKey(chainKey)] = toFiniteNumberOrZero((chainData as any)?.onChainMcap);
        }
      }
    }

    const chains = new Set<string>();
    for (const p of series) for (const c of Object.keys(p.netFlowByChain || {})) chains.add(c);

    assets.push({
      id: String(m.id),
      label,
      assetGroup: typeof m.data.assetGroup === 'string' && m.data.assetGroup.trim() ? m.data.assetGroup.trim() : null,
      platform: typeof m.data.parentPlatform === 'string' && m.data.parentPlatform.trim() ? m.data.parentPlatform.trim() : null,
      series,
      latestMcap,
      latestMcapByChain,
      chains,
    });
  }

  // null day stays null; chains missing supply stay null (unknown, not 0);
  // otherwise this chain's contribution (byChain or a genuine 0).
  const chainMemberSeries = (a: AssetFlows, chainLabel: string): DailyFlow[] =>
    a.series.map((p) => ({
      timestamp: p.timestamp,
      netFlowUsd:
        p.netFlowUsd == null || p.missingChains?.includes(chainLabel)
          ? null
          : (p.netFlowByChain?.[chainLabel] ?? 0),
    }));

  const byGroup: { [g: string]: AssetFlows[] } = {};
  const byPlatform: { [p: string]: AssetFlows[] } = {};
  const byChain: { [c: string]: AssetFlows[] } = {};
  for (const a of assets) {
    if (a.assetGroup) (byGroup[a.assetGroup] ||= []).push(a);
    if (a.platform) (byPlatform[a.platform] ||= []).push(a);
    for (const c of a.chains) (byChain[c] ||= []).push(a);
  }

  const overview = aggregateFlows(assets.map((a) => ({ id: a.label, series: a.series })));
  const groupResults: { [g: string]: FlowAggregateResult } = {};
  for (const [g, members] of Object.entries(byGroup)) groupResults[g] = aggregateFlows(members.map((a) => ({ id: a.label, series: a.series })));
  const platformResults: { [p: string]: FlowAggregateResult } = {};
  for (const [p, members] of Object.entries(byPlatform)) platformResults[p] = aggregateFlows(members.map((a) => ({ id: a.label, series: a.series })));
  const chainResults: { [c: string]: FlowAggregateResult } = {};
  for (const [c, members] of Object.entries(byChain)) chainResults[c] = aggregateFlows(members.map((a) => ({ id: a.label, series: chainMemberSeries(a, c) })));

  // Stacked rotation chart: per timestamp, {dimensionKey: dayFlow}; null days omitted.
  const buildStacked = (results: { [k: string]: FlowAggregateResult }): Array<{ [k: string]: number }> => {
    const byTs: { [ts: number]: { [k: string]: number } } = {};
    for (const [key, r] of Object.entries(results)) {
      for (const p of r.series) {
        if (p.netFlowUsd == null) continue;
        (byTs[p.timestamp] ||= { timestamp: p.timestamp })[key] = p.netFlowUsd;
      }
    }
    return Object.values(byTs).sort((a, b) => a.timestamp - b.timestamp);
  };

  // leaderboard: rank by |Σf| over trailing 7d/30d windows
  const now = Math.floor(Date.now() / 1000);
  const WINDOWS: { [w: string]: number } = { '7d': now - 7 * 86400, '30d': now - 30 * 86400 };
  type LbRow = { id: string; group: string | null; platform: string | null; flow: number; mcap: number; intensityPct: number | null; coverage: number };
  const intensity = (flow: number, mcap: number): number | null => (mcap > 0 ? (flow / mcap) * 100 : null);
  const rankRows = (rows: LbRow[]): LbRow[] => rows.filter((r) => r.flow !== 0).sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow));

  const leaderboard: { [by: string]: { [w: string]: LbRow[] } } = { asset: {}, group: {}, platform: {}, chain: {} };
  for (const [w, startTs] of Object.entries(WINDOWS)) {
    leaderboard.asset[w] = rankRows(assets.map((a) => {
      const { flow, coverage } = sumFlowWindow(a.series, startTs);
      return { id: a.label, group: a.assetGroup, platform: a.platform, flow, mcap: a.latestMcap, intensityPct: intensity(flow, a.latestMcap), coverage };
    }));
    leaderboard.group[w] = rankRows(Object.entries(byGroup).map(([g, members]) => {
      const { flow, coverage } = sumFlowWindow(groupResults[g].series, startTs);
      const mcap = members.reduce((s, a) => s + a.latestMcap, 0);
      return { id: g, group: g, platform: null, flow, mcap, intensityPct: intensity(flow, mcap), coverage };
    }));
    leaderboard.platform[w] = rankRows(Object.entries(byPlatform).map(([p, members]) => {
      const { flow, coverage } = sumFlowWindow(platformResults[p].series, startTs);
      const mcap = members.reduce((s, a) => s + a.latestMcap, 0);
      return { id: p, group: null, platform: p, flow, mcap, intensityPct: intensity(flow, mcap), coverage };
    }));
    leaderboard.chain[w] = rankRows(Object.entries(byChain).map(([c, members]) => {
      const { flow, coverage } = sumFlowWindow(chainResults[c].series, startTs);
      const mcap = members.reduce((s, a) => s + (a.latestMcapByChain[c] || 0), 0);
      return { id: c, group: null, platform: null, flow, mcap, intensityPct: intensity(flow, mcap), coverage };
    }));
  }

  await storeRouteData('flows/overview.json', { series: overview.series, coverage: overview.coverage });
  await storeRouteData('flows/overview-split/group.json', buildStacked(groupResults));
  await storeRouteData('flows/overview-split/chain.json', buildStacked(chainResults));
  for (const [g, r] of Object.entries(groupResults)) await storeRouteData(`flows/group/${rwaSlug(g)}.json`, r);
  for (const [p, r] of Object.entries(platformResults)) await storeRouteData(`flows/platform/${rwaSlug(p)}.json`, r);
  for (const [c, r] of Object.entries(chainResults)) await storeRouteData(`flows/chain/${rwaSlug(c)}.json`, r);
  await storeRouteData('flows/leaderboard.json', leaderboard);

  console.log(`Generated aggregated flows in ${Date.now() - startTime}ms`);
  console.log(`  Assets: ${assets.length}, Groups: ${Object.keys(byGroup).length}, Platforms: ${Object.keys(byPlatform).length}, Chains: ${Object.keys(byChain).length}`);
}

function toTimeseriesBreakdownChart(data: any, chainLabel?: boolean): any {
  const timeseries: any = {};
  for (const [timestamp, dataMap] of Object.entries(data)) {
    for (const assetType of ["base", "includeStablecoin", "includeGovernance", "all"]) {
      for (const key of ["onChainMcap", "activeMcap", "defiActiveTvl"]) {
        const rawKey = `${assetType}-${key}`;
        timeseries[rawKey] = timeseries[rawKey] || [];
        const item: any = { timestamp: Number(timestamp) };
        for (const [itemKey, itemTvl] of Object.entries((dataMap as any)[assetType][key])) {
          const label = chainLabel ? getChainLabelFromKey(itemKey) : itemKey;
          item[label] = Number(itemTvl);
        }
        timeseries[rawKey].push(item);
      }
    }
  }
  return timeseries;
}

async function main() {
  console.log('='.repeat(60));
  console.log('RWA Cron Job Started:', new Date().toISOString());
  console.log('Cache Version:', getCacheVersion());
  console.log('='.repeat(60));

  const totalStartTime = Date.now();

  try {
    // Initialize database connection
    console.log('Initializing database connection...');
    await initPG();

    // Get metadata for ID map and historical generation.
    // Normalize in-place so category names, chains, etc. have consistent whitespace.
    // Raw DB metadata can contain newlines/extra spaces (e.g. "Stablecoins\n  backed by RWAs")
    // which would create separate aggregation keys that slugify identically, causing
    // one set of chart data to silently overwrite the other when saved to disk.
    const allMetadata = await fetchMetadataPG();
    allMetadata.forEach((m: any) => { if (m.data) normalizeRwaMetadataForApiInPlace(m.data); });
    const metadata = allMetadata.filter((m: any) => m.data?.delisted !== true);
    const delistedCount = allMetadata.length - metadata.length;
    console.log(`Fetched metadata for ${metadata.length} RWA assets (excluded ${delistedCount} delisted)`);

    // Generate current data
    const currentData = await generateCurrentData(metadata);

    // Store current data
    if (currentData.length > 0) {
      console.log(`Storing current data for ${currentData.length} assets...`);
      await storeRouteData('current.json', currentData);
    } else {
      console.log("No current data to store");
    }

    // Generate and store ID map
    console.log('Generating ID map...');
    const idMap = generateIdMap(metadata);
    await storeRouteData('id-map.json', idMap);

    // Generate aggregate stats
    const stats = generateAggregateStats(currentData);
    await storeRouteData('stats.json', stats);

    // Generate list immediately after stats so they stay in sync
    const list = generateList(currentData, stats);
    await storeRouteData('list.json', list);

    // PG cache (chain breakdown) now also appends the live hourly tip; replaces the old historical pass no route served.
    await generatePGCache();

    // Generate aggregated historical charts by chain, category, platform
    await generateAggregatedHistoricalCharts(metadata);

    // Aggregated flow series + leaderboard (needs per-asset flow files from above)
    await generateAggregatedFlows(metadata);

    // Clear old cache versions only after the new cache has been fully generated.
    console.log('Clearing old cache versions...');
    await clearOldCacheVersions();

    console.log('='.repeat(60));
    console.log(`RWA Cron Job Completed in ${Date.now() - totalStartTime}ms`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('Error in RWA cron job:', error);
    process.exit(1);
  }
}

// Only auto-run when invoked directly (e.g. `ts-node defi/src/rwa/cron.ts`).
// This guard keeps importing the module from tests / scripts side-effect-free.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

// Run with: npx ts-node defi/src/rwa/cron.ts
