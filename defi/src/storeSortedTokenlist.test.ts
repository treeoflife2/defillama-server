import { getTokenRankingsList } from "./storeSortedTokenlist";

describe("getTokenRankingsList", () => {
  it("keeps token ranking fields and drops image urls", () => {
    expect(
      getTokenRankingsList([
        {
          id: "streamr",
          symbol: "data",
          name: "Streamr",
          image: "https://assets.coingecko.com/coins/images/17869/large/DATA.png",
          image2: "https://token-icons.llamao.fi/icons/tokens/gecko/streamr?w=48&h=48",
          last_updated: "2026-06-29T00:00:00.000Z",
          current_price: 0.02,
          market_cap: 100,
          market_cap_rank: 345,
          market_cap_rank_with_rehypothecated: 300,
          fully_diluted_valuation: 120,
          total_volume: 12,
          circulating_supply: 5000,
          total_supply: 6000,
          max_supply: null,
          price_change_percentage_24h: 1,
          price_change_percentage_1h_in_currency: 0.1,
          price_change_percentage_24h_in_currency: 1,
          price_change_percentage_7d_in_currency: 7,
          price_change_percentage_30d_in_currency: 30,
          future_metric: 123,
        } as any,
      ])
    ).toEqual([
      {
        id: "streamr",
        symbol: "data",
        name: "Streamr",
        last_updated: "2026-06-29T00:00:00.000Z",
        current_price: 0.02,
        market_cap: 100,
        market_cap_rank: 345,
        market_cap_rank_with_rehypothecated: 300,
        fully_diluted_valuation: 120,
        total_volume: 12,
        circulating_supply: 5000,
        total_supply: 6000,
        max_supply: null,
        price_change_percentage_24h: 1,
        price_change_percentage_1h_in_currency: 0.1,
        price_change_percentage_24h_in_currency: 1,
        price_change_percentage_7d_in_currency: 7,
        price_change_percentage_30d_in_currency: 30,
        future_metric: 123,
      },
    ]);
  });
});
