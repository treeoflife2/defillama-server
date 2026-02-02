import { z } from 'zod';

export const rwaAssetSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  website: z.array(z.string()).optional(),
  twitter: z.array(z.string()).optional(),
  primaryChain: z.string(),
  chain: z.array(z.string()),
  contracts: z.record(z.string(), z.array(z.string())).optional(),
  category: z.array(z.string()),
  assetClass: z.array(z.string()).optional(),
  type: z.string(),
  rwaClassification: z.string(),
  accessModel: z.string().optional(),
  issuer: z.string().optional(),
  issuerSourceLink: z.array(z.string()).optional(),
  attestations: z.union([z.array(z.string()), z.boolean(), z.null()]).optional(),
  redeemable: z.boolean().optional(),
  cexListed: z.boolean().optional(),
  transferable: z.boolean().optional(),
  selfCustody: z.boolean().optional(),
  descriptionNotes: z.array(z.string()).optional(),
  stablecoin: z.boolean(),
  governance: z.boolean(),
  price: z.union([z.number(), z.string()]).optional(),
  id: z.string(),
  onChainMcap: z.record(z.string(), z.number()).optional(),
  activeMcap: z.record(z.string(), z.number()).optional(),
  defiActiveTvl: z.record(z.string(), z.record(z.string(), z.number())).optional(),
}).catchall(z.any());

export const rwaCurrentResponseSchema = z.object({
  data: z.array(rwaAssetSchema),
  timestamp: z.number().optional(),
});

// Schema for RWA list response
export const rwaListResponseSchema = z.object({
  tickers: z.array(z.string()),
  platforms: z.array(z.string()),
  chains: z.array(z.string()),
  categories: z.array(z.string()),
});

const chainStatsSchema = z.object({
  base: z.object({
    onChainMcap: z.number(),
    activeMcap: z.number(),
    defiActiveTvl: z.number(),
    assetCount: z.number(),
    assetIssuers: z.number(),
  }).optional(),
  stablecoinsOnly: z.object({
    onChainMcap: z.number(),
    activeMcap: z.number(),
    defiActiveTvl: z.number(),
    assetCount: z.number(),
    assetIssuers: z.number(),
  }).optional(),
  governanceOnly: z.object({
    onChainMcap: z.number(),
    activeMcap: z.number(),
    defiActiveTvl: z.number(),
    assetCount: z.number(),
    assetIssuers: z.number(),
  }).optional(),
  stablecoinsAndGovernance: z.object({
    onChainMcap: z.number(),
    activeMcap: z.number(),
    defiActiveTvl: z.number(),
    assetCount: z.number(),
    assetIssuers: z.number(),
  }).optional(),
});

const categoryStatsSchema = z.object({
  onChainMcap: z.number(),
  activeMcap: z.number(),
  defiActiveTvl: z.number(),
  assetCount: z.number(),
  assetIssuers: z.number(),
});

const platformStatsSchema = z.object({
  onChainMcap: z.number(),
  activeMcap: z.number(),
  defiActiveTvl: z.number(),
  assetCount: z.number(),
  assetIssuers: z.number(),
});

export const rwaStatsResponseSchema = z.object({
  totalOnChainMcap: z.number(),
  totalActiveMcap: z.number(),
  totalDefiActiveTvl: z.number(),
  assetCount: z.number(),
  assetIssuers: z.number(),
  byChain: z.record(z.string(), chainStatsSchema),
  byCategory: z.record(z.string(), categoryStatsSchema),
  byPlatform: z.record(z.string(), platformStatsSchema),
});

// Schema for RWA id-map response (it's just a record of name -> id)
export const rwaIdMapResponseSchema = z.record(z.string(), z.string());

// Schema for chart data point
const chartDataPointSchema = z.object({
  timestamp: z.number(),
  onChainMcap: z.union([z.string(), z.number()]),
  defiActiveTvl: z.union([z.string(), z.number()]),
  activeMcap: z.union([z.string(), z.number()]),
});

// Schema for RWA chart response
export const rwaChartResponseSchema = z.object({
  data: z.array(chartDataPointSchema),
});

// Schema for single RWA response (by ID)
export const rwaSingleResponseSchema = rwaAssetSchema;

// Schema for RWA by category response
export const rwaByCategoryResponseSchema = z.object({
  data: z.array(rwaAssetSchema),
});

// Schema for RWA by chain response
export const rwaByChainResponseSchema = z.object({
  data: z.array(rwaAssetSchema),
});
