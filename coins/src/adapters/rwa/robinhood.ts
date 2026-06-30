import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import { fetch } from "../utils";

// Robinhood tokenized US equities live on Robinhood Chain (chainId 4663). /assets enumerates every
// token + its 18-dp shares-per-token multiplier; /prices gives the live underlying-equity USD
// bid/ask, passed through raw (NOT multiplier-adjusted). There is no historical endpoint, so this
// adapter only writes the current price each cron tick — coverage builds forward, it cannot be
// backfilled from Robinhood.
const ASSETS_API = "https://api.robinhood.com/rhj/assets";
const PRICES_API = "https://api.robinhood.com/rhj/prices";
const CHAIN = "robinhood";
const CHAIN_ID = 4663;
const CONFIDENCE = 0.9;

function chain4663Address(deployments: any[]): string | undefined {
  const d = (deployments || []).find((x) => x.chainId === CHAIN_ID);
  return d?.contractAddress?.toLowerCase();
}

export async function robinhood(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const [assetsRes, pricesRes] = await Promise.all([
    fetch(ASSETS_API),
    fetch(PRICES_API),
  ]);

  // address -> { symbol, multiplier } for ACTIVE tokens deployed on Robinhood Chain
  const meta: { [addr: string]: { symbol: string; multiplier: number } } = {};
  for (const a of assetsRes?.assets ?? []) {
    if (a.status !== "ASSET_STATUS_ACTIVE") continue;
    const addr = chain4663Address(a.deployments);
    if (!addr) continue;
    const multiplier = Number(a.currentMultiplier);
    if (!isFinite(multiplier) || multiplier <= 0) continue;
    meta[addr] = { symbol: a.tokenSymbol, multiplier };
  }

  for (const q of pricesRes?.quotes ?? []) {
    const addr = chain4663Address(q.deployments);
    if (!addr) continue;
    const m = meta[addr];
    if (!m) continue; // inactive, or absent from /assets
    if (q.isTradingHalt) continue; // keep the last good price through halts
    const bid = Number(q.bid);
    const ask = Number(q.ask);
    // bid/ask come through as "0" outside US trading hours (NBBO unavailable). Don't write a
    // zero / half-zero midpoint — skip so the last good price persists.
    if (!(bid > 0) || !(ask > 0)) continue;
    // token USD price = underlying-equity midpoint × shares-per-token multiplier
    const price = ((bid + ask) / 2) * m.multiplier;
    addToDBWritesList(writes, CHAIN, addr, price, 18, m.symbol, timestamp, "robinhood", CONFIDENCE);
  }

  return writes;
}
