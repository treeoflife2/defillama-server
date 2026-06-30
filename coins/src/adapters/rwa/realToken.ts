import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";

// RealToken Wrapped USD (RTW-USD-01) priced by sum of held property token values / RTW supply
const CHAIN = "xdai";
const RTW = "0xd3dff217818b4f33eb38a243158fbed2bbb029d3";
const WRAPPER = "0x10497611Ee6524D75FC45E3739F472F83e282AD5";

async function getNavPrice(api: any): Promise<number> {
  const [factor, supplyRaw, bal] = await Promise.all([
    api.call({ target: WRAPPER, abi: "function PRICE_FACTOR() view returns (uint256)" }),
    api.call({ target: RTW, abi: "uint256:totalSupply" }),
    api.call({ target: WRAPPER, abi: "function getAllTokenBalancesOfWrapper() view returns (address[], uint256[])" }),
  ]);
  const tokens: string[] = bal[0];
  const balances: any[] = bal[1];
  const [prices, decimals] = await Promise.all([
    api.multiCall({
      target: WRAPPER,
      abi: "function getRealTokenPrice(address) view returns (uint256)",
      calls: tokens.map((t) => ({ params: [t] })),
    }),
    api.multiCall({ abi: "erc20:decimals", calls: tokens }),
  ]);
  const nav = tokens.reduce(
    (sum, _t, i) =>
      sum + (Number(balances[i]) / 10 ** Number(decimals[i])) * (Number(prices[i]) / Number(factor)),
    0,
  );
  const supply = Number(supplyRaw) / 1e18;
  if (!(nav > 0) || !(supply > 0)) throw new Error("RTW NAV unavailable");
  return nav / supply;
}

export async function realToken(timestamp: number = 0) {
  const api = await getApi(CHAIN, timestamp);
  const writes: Write[] = [];

  const price = await getNavPrice(api);

  addToDBWritesList(writes, CHAIN, RTW, price, 18, "RTW-USD-01", timestamp, "realtoken-rtw", 0.9);
  return writes;
}