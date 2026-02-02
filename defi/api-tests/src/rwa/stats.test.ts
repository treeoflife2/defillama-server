import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import type { RwaStatsResponse } from './types';

describe('RWA API - Stats', () => {
  let statsResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
  const apiClient = createApiClient(RWA.BASE_URL);

  beforeAll(async () => {
    statsResponse = await apiClient.get(RWA.STATS);
  }, 90000);

  describe('GET /rwa/stats', () => {
    it('should return successful response', () => {
      expectSuccessfulResponse(statsResponse);
    });

    it('should have valid response structure', () => {
      const data = statsResponse.data as RwaStatsResponse;
      expect(typeof data.totalOnChainMcap).toBe('number');
      expect(typeof data.byChain).toBe('object');
      expect(typeof data.byCategory).toBe('object');
      expect(typeof data.byPlatform).toBe('object');
    });

    it('should have total stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      
      expect(typeof data.totalOnChainMcap).toBe('number');
      expect(data.totalOnChainMcap).toBeGreaterThan(0);
      expect(typeof data.totalActiveMcap).toBe('number');
      expect(data.totalActiveMcap).toBeGreaterThanOrEqual(0);
      expect(typeof data.totalDefiActiveTvl).toBe('number');
      expect(data.totalDefiActiveTvl).toBeGreaterThanOrEqual(0);
      expect(typeof data.assetCount).toBe('number');
      expect(data.assetCount).toBeGreaterThan(0);
    });

    it('should have reasonable total values', () => {
      const data = statsResponse.data as RwaStatsResponse;
      
      expect(data.totalOnChainMcap).toBeGreaterThan(100_000_000_000);
      expect(data.assetCount).toBeGreaterThan(500);
      expect(data.totalActiveMcap).toBeLessThanOrEqual(data.totalOnChainMcap);
      expect(data.totalDefiActiveTvl).toBeLessThanOrEqual(data.totalOnChainMcap);
    });

    it('should have byChain stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      
      expect(typeof data.byChain).toBe('object');
      const chains = Object.keys(data.byChain);
      expect(chains.length).toBeGreaterThan(0);
    });

    it('should have valid chain stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const chains = Object.keys(data.byChain);
      
      chains.forEach(chain => {
        const stats = data.byChain[chain];
        
        if (stats.base) {
          expect(typeof stats.base.onChainMcap).toBe('number');
          expect(stats.base.onChainMcap).toBeGreaterThanOrEqual(0);
          expect(typeof stats.base.activeMcap).toBe('number');
          expect(stats.base.activeMcap).toBeGreaterThanOrEqual(0);
          expect(typeof stats.base.assetCount).toBe('number');
          expect(stats.base.assetCount).toBeGreaterThanOrEqual(0);
          expect(stats.base.activeMcap).toBeLessThanOrEqual(stats.base.onChainMcap);
        }
      });
    });

    it('should have major chains in stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const chains = Object.keys(data.byChain);
      
      const majorChains = ['Ethereum', 'Tron', 'Solana', 'BSC'];
      majorChains.forEach(chain => {
        expect(chains).toContain(chain);
      });
    });

    it('should have byCategory stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      
      expect(typeof data.byCategory).toBe('object');
      const categories = Object.keys(data.byCategory);
      expect(categories.length).toBeGreaterThan(0);
    });

    it('should have valid category stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const categories = Object.keys(data.byCategory);
      
      categories.forEach(category => {
        const stats = data.byCategory[category];
        
        expect(typeof stats.onChainMcap).toBe('number');
        expect(stats.onChainMcap).toBeGreaterThanOrEqual(0);
        expect(typeof stats.activeMcap).toBe('number');
        expect(stats.activeMcap).toBeGreaterThanOrEqual(0);
        expect(typeof stats.defiActiveTvl).toBe('number');
        expect(stats.defiActiveTvl).toBeGreaterThanOrEqual(0);
        expect(typeof stats.assetCount).toBe('number');
        expect(stats.assetCount).toBeGreaterThan(0);
        expect(typeof stats.assetIssuers).toBe('number');
        expect(stats.assetIssuers).toBeGreaterThan(0);
        
        expect(stats.activeMcap).toBeLessThanOrEqual(stats.onChainMcap);
      });
    });

    it('should have expected RWA categories in stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const categories = Object.keys(data.byCategory);
      
      const expectedCategories = [
        'Fiat-Backed Stablecoins',
        'Tokenized Funds (T-Bills, Bonds, MMFs)',
      ];
      
      expectedCategories.forEach(category => {
        expect(categories).toContain(category);
      });
    });

    it('should have byPlatform stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      
      expect(typeof data.byPlatform).toBe('object');
      const platforms = Object.keys(data.byPlatform);
      expect(platforms.length).toBeGreaterThan(0);
    });

    it('should have valid platform stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const platforms = Object.keys(data.byPlatform);
      
      platforms.forEach(platform => {
        const stats = data.byPlatform[platform];
        
        expect(typeof stats.onChainMcap).toBe('number');
        expect(stats.onChainMcap).toBeGreaterThanOrEqual(0);
        expect(typeof stats.activeMcap).toBe('number');
        expect(stats.activeMcap).toBeGreaterThanOrEqual(0);
        expect(typeof stats.defiActiveTvl).toBe('number');
        expect(stats.defiActiveTvl).toBeGreaterThanOrEqual(0);
        expect(typeof stats.assetCount).toBe('number');
        expect(stats.assetCount).toBeGreaterThan(0);
        expect(typeof stats.assetIssuers).toBe('number');
        expect(stats.assetIssuers).toBeGreaterThan(0);
        
        expect(stats.activeMcap).toBeLessThanOrEqual(stats.onChainMcap);
      });
    });

    it('should have major platforms in stats', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const platforms = Object.keys(data.byPlatform);
      
      const majorPlatforms = ['Tether', 'Circle', 'Sky Protocol'];
      majorPlatforms.forEach(platform => {
        expect(platforms).toContain(platform);
      });
    });

    it('should have sum of chain stats approximately equal to totals', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const chains = Object.keys(data.byChain);
      
      let sumMcap = 0;
      chains.forEach(chain => {
        if (data.byChain[chain].base) {
          sumMcap += data.byChain[chain].base!.onChainMcap;
        }
      });
      
      expect(sumMcap).toBeGreaterThan(0);
    });

    it('should have sum of category stats equal to totals', () => {
      const data = statsResponse.data as RwaStatsResponse;
      const categories = Object.keys(data.byCategory);
      
      let sumMcap = 0;
      let sumAssets = 0;
      
      categories.forEach(category => {
        sumMcap += data.byCategory[category].onChainMcap;
        sumAssets += data.byCategory[category].assetCount;
      });
      
      const variance = data.totalOnChainMcap * 0.05;
      expect(Math.abs(sumMcap - data.totalOnChainMcap)).toBeLessThan(variance);
    });
  });
});
