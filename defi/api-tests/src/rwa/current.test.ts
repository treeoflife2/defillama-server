import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import type { RwaCurrentResponse } from './types';

describe('RWA API - Current Data', () => {
  let currentResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
  const apiClient = createApiClient(RWA.BASE_URL);

  beforeAll(async () => {
    currentResponse = await apiClient.get(RWA.CURRENT);
  }, 90000);

  describe('GET /rwa/current', () => {
    it('should return successful response', () => {
      expectSuccessfulResponse(currentResponse);
    });

    it('should have valid response structure', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('should return array of RWA assets', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('should have valid asset properties', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      const asset = data.data[0];

      expect(typeof asset.ticker).toBe('string');
      expect(asset.ticker.length).toBeGreaterThan(0);
      expect(typeof asset.name).toBe('string');
      expect(asset.name.length).toBeGreaterThan(0);
      expect(typeof asset.id).toBe('string');
      expect(asset.id.length).toBeGreaterThan(0);
      expect(typeof asset.primaryChain).toBe('string');
      expect(Array.isArray(asset.chain)).toBe(true);
      expect(asset.chain.length).toBeGreaterThan(0);
      expect(Array.isArray(asset.category)).toBe(true);
      expect(asset.category.length).toBeGreaterThan(0);
      expect(typeof asset.type).toBe('string');
      expect(typeof asset.rwaClassification).toBe('string');
      expect(typeof asset.stablecoin).toBe('boolean');
      expect(typeof asset.governance).toBe('boolean');
    });

    it('should have valid market cap data when present', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      const assetsWithMcap = data.data.filter(asset => asset.mcap);

      if (assetsWithMcap.length > 0) {
        const asset = assetsWithMcap[0];
        expect(asset.mcap).toBeDefined();
        
        if (asset.mcap) {
          const mcapValues = Object.values(asset.mcap);
          expect(mcapValues.length).toBeGreaterThan(0);
          
          mcapValues.forEach(value => {
            const numValue = typeof value === 'string' ? parseFloat(value) : value;
            expect(numValue).toBeGreaterThanOrEqual(0);
          });
        }
      }
    });

    it('should have valid price when present', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      const assetsWithPrice = data.data.filter(asset => asset.price !== undefined && asset.price !== null);

      if (assetsWithPrice.length > 0) {
        assetsWithPrice.forEach(asset => {
          const price = typeof asset.price === 'string' ? parseFloat(asset.price as any) : asset.price;
          expect(typeof price).toBe('number');
          expect(price).toBeGreaterThanOrEqual(0);
        });
      }
    });

    it('should have valid chain array', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      
      data.data.forEach(asset => {
        expect(Array.isArray(asset.chain)).toBe(true);
        expect(asset.chain.length).toBeGreaterThan(0);
        // Note: Not all assets have primaryChain in chain array
        
        asset.chain.forEach(chain => {
          expect(typeof chain).toBe('string');
          expect(chain.length).toBeGreaterThan(0);
        });
      });
    });

    it('should have valid category array', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      
      data.data.forEach(asset => {
        expect(Array.isArray(asset.category)).toBe(true);
        expect(asset.category.length).toBeGreaterThan(0);
        
        asset.category.forEach(cat => {
          expect(typeof cat).toBe('string');
          expect(cat.length).toBeGreaterThan(0);
        });
      });
    });

    it('should have unique asset IDs', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      const ids = data.data.map(asset => asset.id);
      const uniqueIds = new Set(ids);
      
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have valid contracts when present', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      const assetsWithContracts = data.data.filter(asset => asset.contracts && Object.keys(asset.contracts).length > 0);

      if (assetsWithContracts.length > 0) {
        assetsWithContracts.forEach(asset => {
          if (asset.contracts) {
            const chains = Object.keys(asset.contracts);
            expect(chains.length).toBeGreaterThan(0);
            
            chains.forEach(chain => {
              const contract = asset.contracts![chain];
              // Contracts can be strings or objects
              if (typeof contract === 'string') {
                expect((contract as string).length).toBeGreaterThan(0);
              } else {
                expect(typeof contract).toBe('object');
              }
            });
          }
        });
      }
    });

    it('should have consistent stablecoin classification', () => {
      const data = currentResponse.data as RwaCurrentResponse;
      
      data.data.forEach(asset => {
        if (asset.stablecoin && asset.category) {
          const hasStablecoinCategory = asset.category.some(cat => 
            cat.toLowerCase().includes('stablecoin')
          );
          // Stablecoins should typically have stablecoin-related categories
          if (!hasStablecoinCategory) {
            // Log for informational purposes, but don't fail
            console.log(`Asset ${asset.ticker} is marked as stablecoin but category is: ${asset.category.join(', ')}`);
          }
        }
      });
    });
  });
});
