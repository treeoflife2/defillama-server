import { timeSToUnix } from "../utils/time";

// Number of days spanned by a set of daily-record timeS keys, first to last (inclusive).
// This is the coverage window used to decide whether total1y is a full trailing-twelve-month
// figure or only a partial history that needs to be annualized to a run-rate.
export function getCoveredDays(recordTimeKeys: string[]): number {
  if (!recordTimeKeys.length) return 0
  const unixDays = recordTimeKeys.map(timeSToUnix).sort((a, b) => a - b)
  return Math.round((unixDays[unixDays.length - 1] - unixDays[0]) / 86400) + 1
}

// Annualized basis used to overload total1y:
//   - >=1y of data  -> actual trailing-twelve-month total (TTM)
//   - <1y of data   -> annualize the available history to a 12-month run-rate
//                       (totalAllTime / coveredDays * 365)
//   - otherwise      -> null, so callers fall back to total30d * 12.2
export function computeAnnualizedTotal1y({ coveredDays, total1y, totalAllTime }: {
  coveredDays: number,
  total1y?: number | null,
  totalAllTime?: number | null,
}): number | null {
  if (!Number.isFinite(coveredDays) || coveredDays <= 0) return null

  let annualized: number | null = null
  if (coveredDays >= 365 && total1y != null) {
    annualized = total1y                              // TTM (actual)
  } else if (totalAllTime != null) {
    annualized = (totalAllTime / coveredDays) * 365   // run-rate
  }

  return Number.isFinite(annualized as number) ? annualized : null
}
