import * as sdk from "@defillama/sdk";
import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { getPoolValues } from "../utils";
import getWrites from "../utils/getWrites";

const pools: { [chain: string]: string[] } = {
  arbitrum: [
    "0x8279699D397ED22b1014fE4D08fFD7Da7B3374C0",
    "0x236b9eE6F185Dc8B70d8bD3649F40ec37688C1Ab",
  ],
};

async function getTokenPrices(
  chain: string,
  timestamp: number,
): Promise<Write[]> {
  const api = await getApi(chain, timestamp);
  const chainPools = pools[chain];

  const [baseTokens, quoteTokens, baseReserves, quoteReserves] =
    await Promise.all([
      api.multiCall({ abi: "function _BASE_TOKEN_() view returns (address)", calls: chainPools, permitFailure: true }),
      api.multiCall({ abi: "function _QUOTE_TOKEN_() view returns (address)", calls: chainPools, permitFailure: true }),
      api.multiCall({ abi: "function _BASE_RESERVE_() view returns (uint112)", calls: chainPools, permitFailure: true }),
      api.multiCall({ abi: "function _QUOTE_RESERVE_() view returns (uint112)", calls: chainPools, permitFailure: true }),
    ]);

  const poolData: any = {};
  chainPools.forEach((pool: string, i: number) => {
    if (!baseTokens[i] || !quoteTokens[i] || !baseReserves[i] || !quoteReserves[i]) return;
    const balances = new sdk.Balances({ chain: api.chain, timestamp: api.timestamp });
    balances.add(baseTokens[i], baseReserves[i]);
    balances.add(quoteTokens[i], quoteReserves[i]);
    poolData[pool] = balances;
  });

  const poolValues = await getPoolValues({ api, pools: poolData });

  const [decimals, supplies] = await Promise.all([
    api.multiCall({ abi: "erc20:decimals", calls: chainPools, permitFailure: true }),
    api.multiCall({ abi: "erc20:totalSupply", calls: chainPools, permitFailure: true }),
  ]);

  const pricesObject: any = {};
  chainPools.forEach((pool: string, i: number) => {
    if (!poolValues[pool]) return;
    let supply = supplies[i];
    if (!supply) return;
    supply /= 10 ** decimals[i];
    const price = poolValues[pool] / supply;
    if (poolValues[pool] > 1e10 || poolValues[pool] < 1e4) return;
    if (price > 0 && price !== Infinity)
      pricesObject[pool] = { price, supply: supplies[i] / 1e24, pool };
  });

  return getWrites({ pricesObject, chain: api.chain, timestamp, writes: [], projectName: "magicLp" });
}

export async function magicLp(timestamp: number = 0) {
  return Promise.all(
    Object.keys(pools).map((chain) => getTokenPrices(chain, timestamp)),
  );
}
