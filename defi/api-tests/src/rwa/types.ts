import { z } from 'zod';
import {
  rwaAssetSchema,
  rwaCurrentResponseSchema,
  rwaListResponseSchema,
  rwaStatsResponseSchema,
  rwaIdMapResponseSchema,
  rwaChartResponseSchema,
  rwaSingleResponseSchema,
  rwaByCategoryResponseSchema,
  rwaByChainResponseSchema,
} from './schemas';

export type RwaAsset = z.infer<typeof rwaAssetSchema>;
export type RwaCurrentResponse = z.infer<typeof rwaCurrentResponseSchema>;
export type RwaListResponse = z.infer<typeof rwaListResponseSchema>;
export type RwaStatsResponse = z.infer<typeof rwaStatsResponseSchema>;
export type RwaIdMapResponse = z.infer<typeof rwaIdMapResponseSchema>;
export type RwaChartResponse = z.infer<typeof rwaChartResponseSchema>;
export type RwaSingleResponse = z.infer<typeof rwaSingleResponseSchema>;
export type RwaByCategoryResponse = z.infer<typeof rwaByCategoryResponseSchema>;
export type RwaByChainResponse = z.infer<typeof rwaByChainResponseSchema>;

// Type guards
export function isRwaCurrentResponse(data: unknown): data is RwaCurrentResponse {
  return rwaCurrentResponseSchema.safeParse(data).success;
}

export function isRwaListResponse(data: unknown): data is RwaListResponse {
  return rwaListResponseSchema.safeParse(data).success;
}

export function isRwaStatsResponse(data: unknown): data is RwaStatsResponse {
  return rwaStatsResponseSchema.safeParse(data).success;
}

export function isRwaIdMapResponse(data: unknown): data is RwaIdMapResponse {
  return rwaIdMapResponseSchema.safeParse(data).success;
}

export function isRwaChartResponse(data: unknown): data is RwaChartResponse {
  return rwaChartResponseSchema.safeParse(data).success;
}

export function isRwaSingleResponse(data: unknown): data is RwaSingleResponse {
  return rwaSingleResponseSchema.safeParse(data).success;
}

export function isRwaByCategoryResponse(data: unknown): data is RwaByCategoryResponse {
  return rwaByCategoryResponseSchema.safeParse(data).success;
}

export function isRwaByChainResponse(data: unknown): data is RwaByChainResponse {
  return rwaByChainResponseSchema.safeParse(data).success;
}
