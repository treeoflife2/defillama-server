import dimensionConfigs from "../adaptors/data/configs";
import emissionsAdapters from "../utils/imports/emissions_adapters";
import { importAdapter, importAdapterDynamic } from "../utils/imports/importAdapter";
import { chainCoingeckoIds, getChainDisplayName, normalizeChain, transformNewChainName } from "../utils/normalizeChain";
import protocols, { protocolsById } from "./data";
import parentProtocols from "./parentProtocols";
import treasuries from "./treasury";
import operationalCosts from "../operationalCosts/daos";
import { sluggifyString } from "../utils/sluggify";
const fs = require("fs");

test("Dimensions: no repeated ids", async () => {
  const chainIdSet = new Set(Object.values(chainCoingeckoIds).map(i => (i.chainId ?? i.cmcId)+''));
  for (const [metric, map] of Object.entries(dimensionConfigs)) {
    const ids = new Set();
    for (const value of Object.values(map)) {
      if (chainIdSet.has(value.id)) continue;
      if (ids.has(value.id)) console.log(`Dimensions: Repeated id ${value.id} in ${metric}`)
      expect(ids).not.toContain(value.id);
      ids.add(value.id);
    }
  }
})
test("Dimensions: no unknown ids", async () => {
  const chainIdSet = new Set(Object.values(chainCoingeckoIds).map(i => (i.chainId ?? i.cmcId)+''));
  let failed = false;
  for (const [metric, map] of Object.entries(dimensionConfigs)) {
    for (const value of Object.values(map)) {
      if (chainIdSet.has(value.id) || protocolsById[value.id]) continue;
      console.log(`Dimensions: Unknown id ${value.id} in ${metric}`);
      failed = true
    }
  }
  expect(failed).toBeFalsy();
})

test("operational expenses: script has been run", async () => {
  const outputData = JSON.parse(fs.readFileSync(`${__dirname}/../operationalCosts/output/expenses.json`, 'utf8'));

  expect(outputData).toEqual(operationalCosts)
});

test("all the dynamic imports work", async () => {
  await Promise.all(protocols.map(importAdapter))
  await Promise.all(treasuries.map(importAdapter))
});

const ignored = ['default', 'staking', 'pool2', 'treasury', "hallmarks", "borrowed", "ownTokens"]
test("all chains are on chainMap", async () => {
  const allProtocols = [protocols, treasuries].flat()
  for (const protocol of allProtocols) {
    const module = await importAdapter(protocol)
    Object.entries(module).map(entry => {
      if (!ignored.includes(entry[0]) && typeof entry[1] === "object") {
        const chain = getChainDisplayName(entry[0], true)
        if (chainCoingeckoIds[chain] === undefined) {
          throw new Error(`${chain} (found in ${protocol.name}) should be on chainMap`)
        }
      }
    })
    const chains = [...protocol.chains]
    if (protocol.chain) chains.push(protocol.chain)
    chains.map(chainRaw => {
      const chain = transformNewChainName(chainRaw)
      if (chainCoingeckoIds[chain] === undefined && chain !== "Multi-Chain") {
        throw new Error(`${chain} (or ${chainRaw}) (found in ${protocol.name}) should be on chainMap`)
      }
    })
  }
});

test("there are no repeated values in unlock adapters", async () => {
  const tokens = [] as string[], protocolIds = [] as string[][], notes = [] as string[][], sources = [] as string[][];
  for (const [protocolName, protocolFile] of Object.entries(emissionsAdapters)) {
    if(protocolName === "daomaker"){
      continue
    }
    const rawProtocol = protocolFile.default
    const protocol = rawProtocol.meta;
    expect(protocol.token).not.toBe(undefined)
    expect(tokens).not.toContain(protocol.token);
    tokens.push(protocol.token);
    if(protocol.protocolIds){
      expect(protocolIds).not.toContain(protocol.protocolIds);
      protocolIds.push(protocol.protocolIds);
    }
    if(protocol.notes){
      expect(notes).not.toContain(protocol.notes);
      notes.push(protocol.notes);
    }
    if(protocol.sources){
      expect(sources).not.toContain(protocol.sources);
      sources.push(protocol.sources);
    }
  }
})

test("valid treasury fields", async () => {
  const treasuryKeys = new Set(['ownTokens', 'tvl'])
  const ignoredKeys = new Set(['default'])
  await Promise.all(treasuries.map(async protocol => {
    const module = await importAdapter(protocol)
    for (const [chain, value] of Object.entries(module)) {
      if (typeof value !== 'object' || ignoredKeys.has(chain)) continue;
      for (const [key, _module] of Object.entries(value as Object)) {
        if ((typeof _module !== 'function'  && _module !== '_lmtf')|| !treasuryKeys.has(key))
          throw new Error('Bad module for adapter: ' + protocol.name + ' in chain ' + chain + ' key:' + key)
      }
    }
  }))
});


test("treasury on parent protocol when it exists", async () => {
  const childWithTreasury = protocols.filter(i => i.treasury && i.parentProtocol)
  if (childWithTreasury.length)
    console.log('Migrate treasuries for: ', childWithTreasury.map(i => i.name))
  expect(childWithTreasury.length).toBeLessThanOrEqual(0)
});

test("governance on parent protocol when it exists", async () => {
  const childGovs = protocols.filter(i => i.governanceID && i.parentProtocol && !['1384', '1401', '1853'].includes(i.id))
  if (childGovs.length)
    console.log('Migrate Governance ids for: ', childGovs.map(i => i.name))
  expect(childGovs.length).toBeLessThanOrEqual(0)
});

test("Github repo on parent protocol when it exists", async () => {
  const childs = protocols.filter(i => i.github && i.parentProtocol)
  if (childs.length)
    console.log('Migrate Guthub config for: ', childs.map(i => i.name))
  expect(childs.length).toBeLessThanOrEqual(0)
});

test("Github: track only orgs", async () => {
  const childs = [...protocols, ...parentProtocols].filter(i => i.github?.find(g=>g.includes('/')))
  if (childs.length)
    console.log('Update github field to org/user or remove it: ', childs.map(i => i.name))
  expect(childs.length).toBeLessThanOrEqual(0)
})

test("projects have a single chain or each chain has an adapter", async () => {
  for (const protocol of protocols) {
    if (protocol.module === 'dummy.js') continue;
    const module = await importAdapterDynamic(protocol)
    const chains = protocol.module.includes("volumes/") ? Object.keys(module) : protocol.chains.map((chain) => normalizeChain(chain));
    if (chains.length > 1) {
      chains.forEach((chain) => {
        if (module[chain] === undefined) {
          if (chain === "avalanche" && module["avax"] !== undefined) {
            return
          }
          throw new Error(
            `Protocol "${protocol.name}" doesn't have chain "${chain}" on their module`
          );
        }
      });
    }
  }
});

test("parentProtocol exists", async () => {
  const parentIds = parentProtocols.map(p=>p.id)
  for (const protocol of protocols) {
    if(protocol.parentProtocol)
    expect(parentIds).toContain(protocol.parentProtocol);
  }
});

test("no id is repeated", async () => {
  const ids = [];
  for (const protocol of (protocols as {id:string}[]).concat(parentProtocols)) {
    expect(ids).not.toContain(protocol.id);
    ids.push(protocol.id);
  }
});

test("no name is repeated", async () => {
  const names = new Set();
  for (const protocol of (protocols as {name:string, previousNames?:string[]}[]).concat(parentProtocols)) {
    for(const name of [protocol.name, ...(protocol.previousNames ?? [])]){
      expect(names).not.toContain(name.toLowerCase());
      names.add(name.toLowerCase())
    }
  }
});

test("no slug is repeated", async () => {
  const slugs = new Set();
  for (const protocol of (protocols).concat(parentProtocols as any)) {
    const slug = sluggifyString(protocol.name.trim());
    expect(slugs).not.toContain(slug);
    slugs.add(slug);
  }
});


test("all oracle names match exactly", async () => {
  const oracles = {} as any;
  for (const protocol of (protocols).concat(parentProtocols as any)) {
    for(const oracle of (protocol.oracles ?? [])){
      const prevOracle = oracles[oracle.toLowerCase()]
      if(prevOracle === undefined){
        oracles[oracle.toLowerCase()]=oracle
      } else {
        expect(prevOracle).toBe(oracle)
      }
    }
  }
});

test("no coingeckoId is repeated", async () => {
  const ids = [];
  for (const protocol of protocols) {
    const id = protocol.gecko_id
    if (typeof id === "string") {
      expect(ids).not.toContain(id);
      ids.push(id);
    }
  }
});

test("forkedFromIds are valid protocol ids", async () => {
  const existingIds = new Set(protocols.map(p => p.id));
  for (const protocol of protocols) {
    if (protocol.forkedFromIds) {
      for (const forkedId of protocol.forkedFromIds) {
        // Check that forkedId is a string number
        expect(typeof forkedId).toBe('string');
        expect(isNaN(Number(forkedId))).toBe(false);
        // Check that forkedId exists as a protocol id
        expect(existingIds).toContain(forkedId);
      }
    }
  }
});


test("no surprise category", async () => {
  const whitelistedCategories = [
    'Dexs',
    'Bridge',
    'Lending',
    'Yield Aggregator',
    'Synthetics',
    'CDP',
    'Services',
    'Insurance',
    'Cross Chain Bridge',
    'Options',
    'Chain',
    'Derivatives',
    'Payments',
    'Privacy',
    'Yield',
    'RWA',
    'Indexes',
    'Algo-Stables',
    'Liquid Staking',
    'Farm',
    'Reserve Currency',
    'Launchpad',
    'Oracle',
    'Prediction Market',
    'NFT Marketplace',
    'NFT Lending',
    'Gaming',
    'Uncollateralized Lending',
    'Exotic Options',
    'CEX',
    'Leveraged Farming',
    'RWA Lending',
    'Options Vault',
    'Liquidity manager',
    'Staking Pool',
    'Partially Algorithmic Stablecoin',
    'SoFi',
    'DEX Aggregator',
    'Liquid Restaking',
    'Restaking',
    'Wallets',
    'NftFi',
    'Telegram Bot',
    'Ponzi',
    'Basis Trading',
    'MEV',
    'CeDeFi',
    'CDP Manager',
    'Governance Incentives',
    'Restaked BTC',
    'Security Extension',
    'Anchor BTC',
    'AI Agents',
    'Treasury Manager',
    'OTC Marketplace',
    'Yield Lottery',
    'Decentralized BTC',
    'Token Locker',
    'Bug Bounty',
    'DCA Tools',
    'Onchain Capital Allocator',
    'Developer Tools',
    'Stablecoin Issuer',
    'Coins Tracker',
    'Domains',
    'NFT Launchpad',
    'Trading App',
    'Foundation',
    'Bridge Aggregator',
    'Liquidations',
    'Portfolio Tracker',
    'Liquidity Automation',
    'Charity Fundraising',
    'Volume Boosting',
    'DOR',
    'Collateral Management',
    'Meme',
    'Private Investment Platform',
    'Risk Curators',
    'Chain Bribes',
    'DAO Service Provider',
    'Staking Rental',
    'Canonical Bridge',
    'Interface'
  ]
  for (const protocol of protocols) {
    expect(whitelistedCategories).toContain(protocol.category);
  }
});

test("no module repeated", async () => {
  const ids = [];
  for (const protocol of protocols) {
    const script = protocol.module
    if (script === 'dummy.js') continue; // dummy.js is an exception
    if (script === 'anyhedge/index.js') continue; // anyhedge/index.js is an exception, used as short hand for skipping tvl update
    expect(ids).not.toContain(script);
    ids.push(script);
  }
});

/*
test("icon exists", async () => {
  for (const protocol of protocols) {
    const icon = protocol.logo?.substr(baseIconsUrl.length + 1);
    if (icon !== undefined) {
      const path = `./icons/${icon}`;
      if (!fs.existsSync(path)) {
        throw new Error(`Icon ${path} doesn't exist`);
      }
    }
  }
});
*/
