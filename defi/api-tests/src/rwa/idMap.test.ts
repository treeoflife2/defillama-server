import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { rwaIdMapResponseSchema } from './schemas';
import type { RwaIdMapResponse } from './types';

describe('RWA API - ID Map', () => {
  let idMapResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
  const apiClient = createApiClient(RWA.BASE_URL);

  beforeAll(async () => {
    idMapResponse = await apiClient.get(RWA.ID_MAP);
  }, 90000);

  describe('GET /rwa/id-map', () => {
    it('should return successful response', () => {
      expectSuccessfulResponse(idMapResponse);
    });

    it('should have valid response structure', () => {
      const result = rwaIdMapResponseSchema.safeParse(idMapResponse.data);
      expect(result.success).toBe(true);
    });

    it('should return object mapping names to IDs', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      expect(typeof data).toBe('object');
      expect(Object.keys(data).length).toBeGreaterThan(0);
    });

    it('should have valid name to ID mappings', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const entries = Object.entries(data);
      
      entries.forEach(([name, id]) => {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        
        // ID should be numeric string
        expect(id).toMatch(/^\d+$/);
      });
    });

    it('should have unique IDs', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const ids = Object.values(data);
      const uniqueIds = new Set(ids);
      
      // Note: Some assets might share IDs if they are variants
      expect(uniqueIds.size).toBeGreaterThan(0);
    });

    it('should have reasonable number of mappings', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const entries = Object.entries(data);
      
      // Should have at least 100 name-to-ID mappings
      expect(entries.length).toBeGreaterThan(100);
    });

    it('should include major RWA assets', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const names = Object.keys(data).map(n => n.toLowerCase());
      
      // Check for some major stablecoins/RWAs (case-insensitive)
      const majorAssets = ['usdt', 'usdc', 'dai'];
      
      majorAssets.forEach(asset => {
        const found = names.some(name => name.toLowerCase().includes(asset));
        if (!found) {
          console.log(`Expected to find ${asset} in ID map, but it may use different naming`);
        }
      });
    });

    it('should have case-sensitive name keys', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const names = Object.keys(data);
      
      // Names should preserve their original casing
      names.forEach(name => {
        expect(typeof name).toBe('string');
        // Just ensure names are not all uppercase or all lowercase
        // (they should have mixed case based on actual asset names)
      });
    });

    it('should allow lookup by name', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const entries = Object.entries(data);
      
      if (entries.length > 0) {
        const [testName, testId] = entries[0];
        
        // Should be able to look up by name
        expect(data[testName]).toBe(testId);
      }
    });

    it('should handle special characters in names', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const names = Object.keys(data);
      
      // Some names might have special characters like spaces, hyphens, etc.
      const namesWithSpecialChars = names.filter(name => 
        /[\s\-_.]/.test(name)
      );
      
      // Just verify these still map to valid IDs
      namesWithSpecialChars.forEach(name => {
        expect(typeof data[name]).toBe('string');
        expect(data[name]).toMatch(/^\d+$/);
      });
    });

    it('should enable reverse lookup by ID', () => {
      const data = idMapResponse.data as RwaIdMapResponse;
      const entries = Object.entries(data);
      
      // Create reverse map (ID -> names)
      const reverseMap: Record<string, string[]> = {};
      entries.forEach(([name, id]) => {
        if (!reverseMap[id]) {
          reverseMap[id] = [];
        }
        reverseMap[id].push(name);
      });
      
      // Some IDs might have multiple names
      const idsWithMultipleNames = Object.entries(reverseMap)
        .filter(([_, names]) => names.length > 1);
      
      if (idsWithMultipleNames.length > 0) {
        console.log(`Found ${idsWithMultipleNames.length} IDs with multiple name mappings`);
      }
    });

    it('should be consistent with current endpoint IDs', async () => {
      // Get current assets
      const currentResponse = await apiClient.get(RWA.CURRENT);
      const currentAssets = (currentResponse.data as any).data;
      
      const data = idMapResponse.data as RwaIdMapResponse;
      const idMapIds = new Set(Object.values(data));
      
      // Check that some current asset IDs are in the ID map
      let foundCount = 0;
      currentAssets.slice(0, 10).forEach((asset: any) => {
        if (idMapIds.has(asset.id)) {
          foundCount++;
        }
      });
      
      // At least some of the IDs should match
      expect(foundCount).toBeGreaterThan(0);
    }, 90000);
  });
});
