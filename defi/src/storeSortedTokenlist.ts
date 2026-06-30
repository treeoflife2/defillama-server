import { storeR2JSONString } from "./utils/r2";
import { wrapScheduledLambda } from "./utils/shared/wrap";
import fetch from "node-fetch";
import sleep from "./utils/shared/sleep";

const SORTED_TOKENLIST_KEY = "tokenlist/sorted.json";
const TOKEN_RANKINGS_KEY = "tokenlist/rankings.json";
const CG_TOKEN_API = `https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=<PLACEHOLDER>&include_rehypothecated=true&price_change_percentage=1h,24h,7d,30d&x_cg_pro_api_key=${process.env.CG_KEY}`;

type CGTokenMarket = {
  id: string;
  symbol: string;
  name: string;
  image?: string | null;
  image2?: string | null;
  last_updated?: string | null;
  current_price?: number | null;
  market_cap?: number | null;
  market_cap_rank?: number | null;
  market_cap_rank_with_rehypothecated?: number | null;
  fully_diluted_valuation?: number | null;
  total_volume?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
};

type TokenRanking = Omit<CGTokenMarket, "image" | "image2">;

async function cgRequest(url: string) {
  let data;
  for (let i = 0; i < 10; i++) {
    try {
      console.log(Date.now() / 1e3);
      data = await fetch(url).then((res) => res.json());
      await sleep(1200);
      if (data?.status?.error_code) {
        throw Error();
      }
      return data;
    } catch (e) {
      console.log(`error ${i}`);
      await sleep(1e3);
    }
  }
  console.log(data);
  throw Error(`Coingecko fails on "${url}"`);
}

const arrayFetcher = async (urlArr: string[]) => {
  const results = [];
  for (const url of urlArr) {
    let data = await cgRequest(url);
    results.push(data);
  }
  return results;
};

function getCGMarketsDataURLs() {
  const urls: string[] = [];
  const maxPage = 31;
  for (let page = 1; page <= maxPage; page++) {
    urls.push(`${CG_TOKEN_API.replace("<PLACEHOLDER>", `${page}`)}`);
  }
  return urls;
}

export function getTokenRankingsList(tokens: CGTokenMarket[]): TokenRanking[] {
  const rankings: TokenRanking[] = [];
  for (const { image: _image, image2: _image2, ...ranking } of tokens) {
    rankings.push(ranking);
  }
  return rankings;
}

export async function getAllCGTokensList(): Promise<CGTokenMarket[]> {
  const data = await arrayFetcher(getCGMarketsDataURLs());

  return (
    data?.flat()?.map((t) => ({
      ...t,
      symbol: t.symbol === "mimatic" ? "mai" : t.symbol,
      image2: `https://token-icons.llamao.fi/icons/tokens/gecko/${t.id}?w=48&h=48`,
    })) ?? []
  );
}

const handler = async () => {
  const list = await getAllCGTokensList();
  await Promise.all([
    storeR2JSONString(SORTED_TOKENLIST_KEY, JSON.stringify(list), 60 * 60),
    storeR2JSONString(TOKEN_RANKINGS_KEY, JSON.stringify(getTokenRankingsList(list)), 60 * 60),
  ]);
};

export default wrapScheduledLambda(handler);
