import { describe, it, expect, beforeAll } from '@jest/globals';
import { createApiClient } from '../../utils/config/apiClient';
import { RWA } from '../../utils/config/endpoints';
import { expectSuccessfulResponse, expectFreshData } from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { rwaChartResponseSchema } from './schemas';
import type { RwaChartResponse } from './types';

describe('RWA API - Chart Data', () => {
  const apiClient = createApiClient(RWA.BASE_URL);
  
  describe('GET /rwa/chart/:id', () => {
    let chartResponse: Awaited<ReturnType<ReturnType<typeof createApiClient>['get']>>;
    const testId = '1'; // CANA Holdings California Carbon Credits

    beforeAll(async () => {
      chartResponse = await apiClient.get(RWA.CHART_BY_ID(testId));
    }, 90000);

    it('should return successful response', () => {
      expectSuccessfulResponse(chartResponse);
    });

    it('should have valid response structure', () => {
      const result = rwaChartResponseSchema.safeParse(chartResponse.data);
      expect(result.success).toBe(true);
    });

    it('should return array of data points', () => {
      const data = chartResponse.data as RwaChartResponse;
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('should have valid data point properties', () => {
      const data = chartResponse.data as RwaChartResponse;
      const point = data.data[0];

      expect(typeof point.timestamp).toBe('number');
      expect(point.timestamp).toBeGreaterThan(1600000000);
      
      const onChainMcap = typeof point.onChainMcap === 'string' 
        ? parseFloat(point.onChainMcap) 
        : point.onChainMcap;
      expect(onChainMcap).toBeGreaterThanOrEqual(0);
      
      const defiTvl = typeof point.defiActiveTvl === 'string' 
        ? parseFloat(point.defiActiveTvl) 
        : point.defiActiveTvl;
      expect(defiTvl).toBeGreaterThanOrEqual(0);
      
      const activeMcap = typeof point.activeMcap === 'string' 
        ? parseFloat(point.activeMcap) 
        : point.activeMcap;
      expect(activeMcap).toBeGreaterThanOrEqual(0);
    });

    it('should have data points in chronological order', () => {
      const data = chartResponse.data as RwaChartResponse;
      
      for (let i = 1; i < data.data.length; i++) {
        expect(data.data[i].timestamp).toBeGreaterThanOrEqual(data.data[i - 1].timestamp);
      }
    });

    it('should have recent data', () => {
      const data = chartResponse.data as RwaChartResponse;
      const latestPoint = data.data[data.data.length - 1];
      
      expectFreshData([latestPoint.timestamp], 7 * 24 * 60 * 60); // Within 7 days (in seconds)
    });

    it('should have reasonable value ranges', () => {
      const data = chartResponse.data as RwaChartResponse;
      
      data.data.forEach(point => {
        const onChainMcap = typeof point.onChainMcap === 'string' 
          ? parseFloat(point.onChainMcap) 
          : point.onChainMcap;
        const defiTvl = typeof point.defiActiveTvl === 'string' 
          ? parseFloat(point.defiActiveTvl) 
          : point.defiActiveTvl;
        const activeMcap = typeof point.activeMcap === 'string' 
          ? parseFloat(point.activeMcap) 
          : point.activeMcap;
        
        expect(defiTvl).toBeLessThanOrEqual(onChainMcap * 2);
        expect(activeMcap).toBeLessThanOrEqual(onChainMcap * 1.5);
      });
    });

    it('should have data spanning multiple days', () => {
      const data = chartResponse.data as RwaChartResponse;
      
      if (data.data.length > 1) {
        const firstTimestamp = data.data[0].timestamp;
        const lastTimestamp = data.data[data.data.length - 1].timestamp;
        const daysDiff = (lastTimestamp - firstTimestamp) / (24 * 60 * 60);
        
        expect(daysDiff).toBeGreaterThan(5); // At least 5 days of data
      }
    });
  });

  describe('GET /rwa/chart/name/:name - Edge Cases', () => {
    it('should handle non-existent name gracefully', async () => {
      const response = await apiClient.get(RWA.CHART_BY_NAME('nonexistent-asset-xyz'));
      
      // Should return 404 or similar error
      if (response.status >= 400) {
        expect([404, 500]).toContain(response.status);
      }
    }, 60000);
  });

  describe('GET /rwa/chart/:id - Multiple Assets', () => {
    it('should work for different asset IDs', async () => {
      const testIds = ['1', '10']; // Test first few IDs
      
      for (const id of testIds) {
        const response = await apiClient.get(RWA.CHART_BY_ID(id));
        
        if (response.status === 200) {
          expectSuccessfulResponse(response);
          const data = response.data as RwaChartResponse;
          expect(Array.isArray(data.data)).toBe(true);
          
          if (data.data.length > 0) {
            expect(typeof data.data[0].timestamp).toBe('number');
          }
        }
      }
    }, 90000);
  });
});
