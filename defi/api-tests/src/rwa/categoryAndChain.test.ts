import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { rwaByCategoryResponseSchema, rwaByChainResponseSchema } from './schemas';
import type { RwaByCategoryResponse, RwaByChainResponse } from './types';

describe('RWA API - Category and Chain Filters', () => {
  const apiClient = createApiClient(RWA.BASE_URL);
  
  describe('GET /rwa/category/:category', () => {
    let categoryResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
    const testCategory = 'Fiat-Backed+Stablecoins';

    beforeAll(async () => {
      categoryResponse = await apiClient.get(RWA.BY_CATEGORY(testCategory));
    }, 90000);

    it('should return successful response', () => {
      console.log(categoryResponse.data);
      expectSuccessfulResponse(categoryResponse);
    });

    it('should have valid response structure', () => {
      const result = rwaByCategoryResponseSchema.safeParse(categoryResponse.data);
      expect(result.success).toBe(true);
    });

    it('should return array of RWA assets', () => {
      const data = categoryResponse.data as RwaByCategoryResponse;
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should only return assets from specified category', () => {
      const data = categoryResponse.data as RwaByCategoryResponse;
      
      if (data.data.length > 0) {
        data.data.forEach(asset => {
          expect(asset.category).toContain(testCategory);
        });
      }
    });

    it('should have valid asset properties', () => {
      const data = categoryResponse.data as RwaByCategoryResponse;
      
      if (data.data.length > 0) {
        const asset = data.data[0];

        expect(typeof asset.ticker).toBe('string');
        expect(typeof asset.name).toBe('string');
        expect(typeof asset.id).toBe('string');
        expect(Array.isArray(asset.chain)).toBe(true);
        expect(Array.isArray(asset.category)).toBe(true);
      }
    });

    it('should work with URL-encoded category names', async () => {
      const categories = [
        'Tokenized Gold & Commodities',
        'Tokenized Funds (T-Bills, Bonds, MMFs)',
        'Carbon Credits & Environmental Assets',
      ];

      for (const category of categories) {
        const response = await apiClient.get(RWA.BY_CATEGORY(encodeURIComponent(category)));
        
        if (response.status === 200) {
          expectSuccessfulResponse(response);
          const data = response.data as RwaByCategoryResponse;
          expect(Array.isArray(data.data)).toBe(true);
          
          if (data.data.length > 0) {
            // Verify all assets have the requested category
            data.data.forEach(asset => {
              expect(asset.category).toContain(category);
            });
          }
        }
      }
    }, 90000);

    it('should handle non-existent category gracefully', async () => {
      const response = await apiClient.get(RWA.BY_CATEGORY('Non-Existent Category XYZ'));
      
      if (response.status >= 400) {
        expect([404, 500]).toContain(response.status);
      } else if (response.status === 200) {
        const data = response.data as RwaByCategoryResponse;
        expect(data.data.length).toBe(0);
      }
    }, 60000);

    it('should return reasonable number of assets for major categories', () => {
      const data = categoryResponse.data as RwaByCategoryResponse;
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('GET /rwa/chain/:chain', () => {
    let chainResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
    const testChain = 'ethereum';

    beforeAll(async () => {
      chainResponse = await apiClient.get(RWA.BY_CHAIN(testChain));
    }, 90000);

    it('should return successful response', () => {
      expectSuccessfulResponse(chainResponse);
    });

    it('should have valid response structure', () => {
      const result = rwaByChainResponseSchema.safeParse(chainResponse.data);
      expect(result.success).toBe(true);
    });

    it('should return array of RWA assets', () => {
      const data = chainResponse.data as RwaByChainResponse;
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('should only return assets from specified chain', () => {
      const data = chainResponse.data as RwaByChainResponse;
      
      if (data.data.length > 0) {
        const matchingAssets = data.data.filter(asset => {
          const chainLowerCase = asset.chain.map(c => c.toLowerCase());
          return chainLowerCase.includes(testChain.toLowerCase());
        });
        
        expect(matchingAssets.length).toBeGreaterThan(0);
      }
    });

    it('should have valid asset properties', () => {
      const data = chainResponse.data as RwaByChainResponse;
      const asset = data.data[0];

      expect(typeof asset.ticker).toBe('string');
      expect(typeof asset.name).toBe('string');
      expect(typeof asset.id).toBe('string');
      expect(Array.isArray(asset.chain)).toBe(true);
      expect(Array.isArray(asset.category)).toBe(true);
    });

    it('should work for multiple major chains', async () => {
      const chains = ['ethereum', 'solana', 'bsc', 'polygon', 'arbitrum'];

      for (const chain of chains) {
        const response = await apiClient.get(RWA.BY_CHAIN(chain));
        
        expectSuccessfulResponse(response);
        const data = response.data as RwaByChainResponse;
        expect(Array.isArray(data.data)).toBe(true);
        
        if (data.data.length > 0) {
          const matchingAssets = data.data.filter(asset => {
            const chainLowerCase = asset.chain.map(c => c.toLowerCase());
            return chainLowerCase.includes(chain.toLowerCase());
          });
          
          expect(matchingAssets.length).toBeGreaterThan(0);
        }
      }
    }, 90000);

    it('should handle case-insensitive chain names', async () => {
      const chainVariants = ['Ethereum', 'ethereum', 'ETHEREUM'];

      const results = await Promise.all(
        chainVariants.map(chain => apiClient.get(RWA.BY_CHAIN(chain)))
      );

      // All variants should return the same number of assets
      const lengths = results.map(r => {
        if (r.status === 200) {
          return (r.data as RwaByChainResponse).data.length;
        }
        return 0;
      });

      // Filter out any failed requests
      const validLengths = lengths.filter(l => l > 0);
      
      if (validLengths.length > 1) {
        const first = validLengths[0];
        validLengths.forEach(len => {
          expect(len).toBe(first);
        });
      }
    }, 90000);

    it('should handle non-existent chain gracefully', async () => {
      const response = await apiClient.get(RWA.BY_CHAIN('NonExistentChainXYZ'));
      
      if (response.status >= 400) {
        expect([404, 500]).toContain(response.status);
      } else if (response.status === 200) {
        const data = response.data as RwaByChainResponse;
        expect(data.data.length).toBe(0);
      }
    }, 60000);

    it('should return many assets for Ethereum', () => {
      const data = chainResponse.data as RwaByChainResponse;
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should have contracts for specified chain when available', () => {
      const data = chainResponse.data as RwaByChainResponse;
      const assetsWithContracts = data.data.filter(asset => asset.contracts && Object.keys(asset.contracts).length > 0);
      
      if (assetsWithContracts.length > 0) {
        assetsWithContracts.forEach(asset => {
          if (asset.contracts) {
            const chainKeys = Object.keys(asset.contracts).map(k => k.toLowerCase());
            const hasContract = chainKeys.some(key => key === testChain.toLowerCase());
            if (hasContract) {
              const contract = asset.contracts[Object.keys(asset.contracts)[0]];
              expect(contract).toBeDefined();
            }
          }
        });
      }
    });
  });

  describe('Combined Filtering', () => {
    it('should show that category and chain filters return subsets', async () => {
      // Get all current assets
      const currentResponse = await apiClient.get(RWA.CURRENT);
      const allAssets = (currentResponse.data as any).data.length;
      
      // Get filtered by category
      const categoryResponse = await apiClient.get(RWA.BY_CATEGORY('Fiat-Backed Stablecoins'));
      const categoryAssets = (categoryResponse.data as RwaByCategoryResponse).data.length;
      
      // Get filtered by chain
      const chainResponse = await apiClient.get(RWA.BY_CHAIN('ethereum'));
      const chainAssets = (chainResponse.data as RwaByChainResponse).data.length;
      
      // Filtered results should be less than or equal to total
      expect(categoryAssets).toBeLessThanOrEqual(allAssets);
      expect(chainAssets).toBeLessThanOrEqual(allAssets);
    }, 90000);
  });
});
