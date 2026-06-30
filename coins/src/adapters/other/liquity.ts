import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";

const contracts: {
  [chain: string]: {
    manager: string;
    feed: string;
    underlying: string;
    token: string;
  };
} = {
  telos: {
    manager: "0xb1F92104E1Ad5Ed84592666EfB1eB52b946E6e68",
    feed: "0xE421fC686099C4Dec31c9D58B51DE9608665FBF2",
    underlying: "0xd102ce6a4db07d247fcc28f366a623df0938ca9e",
    token: "0x8f7D64ea96D729EF24a0F30b4526D47b80d877B9",
  },
  // Money Protocol (BPD) - Liquity fork on Rootstock; RBTC underlying redirects to bitcoin
  rsk: {
    manager: "0xb6a3e678219d9119ae3B65AC501638b986B5038b",
    feed: "0x2D4E701fB9Ad7cE1FBdf6817Ea92BE5B4C1c612F",
    underlying: "0x0000000000000000000000000000000000000000",
    token: "0x1fe2F558E2120C4BdF4217248d2940043a8E1208",
  },
};

const abi: { [name: string]: any } = {
  getRedemptionRate: 'uint256:getRedemptionRate',
  fetchPrice: 'uint256:fetchPrice',
};

async function getTokenPrice(chain: string, timestamp: number) {
  const api = await getApi(chain, timestamp);
  const { manager, feed, underlying, token } = contracts[chain];

  let [rate, oracle] = await Promise.all([
    api.call({
      target: manager,
      abi: abi.getRedemptionRate,
    }),
    api.call({
      target: feed,
      abi: abi.fetchPrice,
    }),
  ]);

  const underlyingPrice = oracle / 1e18;
  const fee = rate / 1e18;
  const price = (1 - fee) / underlyingPrice;

  return getWrites({
    chain,
    timestamp,
    pricesObject: {
      [token]: {
        price,
        underlying,
      },
    },
    projectName: "liquity",
  });
}

export const liquity = async (timestamp: number = 0) =>
  Promise.all(
    Object.keys(contracts).map((chain: string) =>
      getTokenPrice(chain, timestamp),
    ),
  );

// ts-node coins/src/adapters/other/liquity.ts
