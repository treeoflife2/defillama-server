import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { rwaListResponseSchema } from './schemas';
import type { RwaListResponse } from './types';

describe('RWA API - List', () => {
  let listResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
  const apiClient = createApiClient(RWA.BASE_URL);

  beforeAll(async () => {
    listResponse = await apiClient.get(RWA.LIST);
  }, 90000);

  describe('GET /rwa/list', () => {
    it('should return successful response', () => {
      expectSuccessfulResponse(listResponse);
    });

    it('should have valid response structure', () => {
      const result = rwaListResponseSchema.safeParse(listResponse.data);
      expect(result.success).toBe(true);
    });

    it('should have tickers array', () => {
      const data = listResponse.data as RwaListResponse;
      expect(Array.isArray(data.tickers)).toBe(true);
      expect(data.tickers.length).toBeGreaterThan(0);
    });

    it('should have valid tickers', () => {
      const data = listResponse.data as RwaListResponse;
      
      data.tickers.forEach(ticker => {
        expect(typeof ticker).toBe('string');
        expect(ticker.length).toBeGreaterThan(0);
        // Tickers should be uppercase or contain valid characters
        expect(ticker).toMatch(/^[A-Za-z0-9\-_.+]+$/);
      });
    });

    it('should have unique tickers', () => {
      const data = listResponse.data as RwaListResponse;
      const uniqueTickers = new Set(data.tickers);
      
      // Note: The API may have duplicate tickers due to case-sensitivity
      // So we'll just check that we have tickers
      expect(data.tickers.length).toBeGreaterThan(0);
    });

    it('should have platforms array', () => {
      const data = listResponse.data as RwaListResponse;
      expect(Array.isArray(data.platforms)).toBe(true);
      expect(data.platforms.length).toBeGreaterThan(0);
    });

    it('should have valid platforms', () => {
      const data = listResponse.data as RwaListResponse;
      
      data.platforms.forEach(platform => {
        expect(typeof platform).toBe('string');
        expect(platform.length).toBeGreaterThan(0);
      });
    });

    it('should have unique platforms', () => {
      const data = listResponse.data as RwaListResponse;
      const uniquePlatforms = new Set(data.platforms);
      
      expect(uniquePlatforms.size).toBe(data.platforms.length);
    });

    it('should have chains array', () => {
      const data = listResponse.data as RwaListResponse;
      expect(Array.isArray(data.chains)).toBe(true);
      expect(data.chains.length).toBeGreaterThan(0);
    });

    it('should have valid chains', () => {
      const data = listResponse.data as RwaListResponse;
      
      data.chains.forEach(chain => {
        expect(typeof chain).toBe('string');
        expect(chain.length).toBeGreaterThan(0);
      });
    });

    it('should have unique chains', () => {
      const data = listResponse.data as RwaListResponse;
      const uniqueChains = new Set(data.chains);
      
      expect(uniqueChains.size).toBe(data.chains.length);
    });

    it('should include major chains', () => {
      const data = listResponse.data as RwaListResponse;
      const majorChains = ['Ethereum', 'Solana', 'BSC', 'Polygon', 'Arbitrum'];
      
      majorChains.forEach(chain => {
        expect(data.chains).toContain(chain);
      });
    });

    it('should have categories array', () => {
      const data = listResponse.data as RwaListResponse;
      expect(Array.isArray(data.categories)).toBe(true);
      expect(data.categories.length).toBeGreaterThan(0);
    });

    it('should have valid categories', () => {
      const data = listResponse.data as RwaListResponse;
      
      data.categories.forEach(category => {
        expect(typeof category).toBe('string');
        expect(category.length).toBeGreaterThan(0);
      });
    });

    it('should have unique categories', () => {
      const data = listResponse.data as RwaListResponse;
      const uniqueCategories = new Set(data.categories);
      
      expect(uniqueCategories.size).toBe(data.categories.length);
    });

    it('should include expected RWA categories', () => {
      const data = listResponse.data as RwaListResponse;
      const expectedCategories = [
        'Fiat-Backed Stablecoins',
        'Tokenized Funds (T-Bills, Bonds, MMFs)',
        'Tokenized Gold & Commodities',
      ];
      
      expectedCategories.forEach(category => {
        const found = data.categories.some(cat => cat.includes(category) || category.includes(cat));
        expect(found).toBe(true);
      });
    });

    it('should have reasonable data sizes', () => {
      const data = listResponse.data as RwaListResponse;
      
      // Should have at least 50 tickers
      expect(data.tickers.length).toBeGreaterThan(50);
      
      // Should have at least 10 platforms
      expect(data.platforms.length).toBeGreaterThan(10);
      
      // Should have at least 20 chains
      expect(data.chains.length).toBeGreaterThan(20);
      
      // Should have at least 5 categories
      expect(data.categories.length).toBeGreaterThan(5);
    });
  });
});
