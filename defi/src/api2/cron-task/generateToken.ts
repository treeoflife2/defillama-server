/**
 * Generates token cache file served at /config/smol/token.json
 * Ported from: https://github.com/DefiLlama/defillama-app/blob/main/scripts/generateTokenJson.js
 */

import { readRouteData, storeRouteData } from "../cache/file-cache";
import { runWithRuntimeLogging } from "../utils";

const SOURCE_URL = "https://ask.llama.fi/coins";
const PROTOCOLS_URL = "/config/smol/appMetadata-protocols.json";
const CHAINS_URL = "/config/smol/appMetadata-chains.json";
const TOKEN_RIGHTS_URL = "/token-rights";
const OUTPUT_ROUTE = "config/smol/token.json";
const TOKEN_ROUTES_ROUTE = "config/smol/token-routes.json";

type TokenRouteRegistry = Record<string, { key: string; route: string }>;

type TokenDirectoryBuildResult = {
  bySlug: Record<string, any>;
  routeRegistry: TokenRouteRegistry;
  nameFallbackCount: number;
  preservedMissingTokenCount: number;
  reservedRouteCount: number;
  skippedDuplicateRouteKeyCount: number;
};

const slug = (value = "") =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/'/g, "");

const getCoingeckoId = (tokenNk: string | undefined) => {
  if (typeof tokenNk !== "string") return null;
  if (!tokenNk.startsWith("coingecko:")) return null;
  const geckoId = tokenNk.slice("coingecko:".length).trim().toLowerCase();
  return geckoId || null;
};

const getTokenLogo = (tokenNk: string | undefined) => {
  const geckoId = getCoingeckoId(tokenNk);
  if (!geckoId) return null;
  return `https://token-icons.llamao.fi/icons/tokens/gecko/${geckoId}?w=48&h=48`;
};

const shouldPreferProtocolId = (currentProtocolId: string | undefined, nextProtocolId: string) => {
  if (!currentProtocolId) return true;
  if (!nextProtocolId) return false;
  const currentIsParent = currentProtocolId.startsWith("parent#");
  const nextIsParent = nextProtocolId.startsWith("parent#");
  if (nextIsParent && !currentIsParent) return true;
  return false;
};

export const getTokenRightsSymbols = (tokenRightsData: any[] | null) => {
  const symbols = new Set<string>();
  for (const item of tokenRightsData ?? []) {
    if (!Array.isArray(item?.Token)) continue;
    for (const token of item.Token) {
      if (typeof token !== "string" || !token.trim()) continue;
      symbols.add(token.trim().toLowerCase());
    }
  }
  return symbols;
};

const getTokenMetadataExtrasByGeckoId = (
  protocolsMetadata: Record<string, any>,
  chainsMetadata: Record<string, any>
) => {
  const extrasByGeckoId = new Map<string, any>();

  for (const [protocolId, item] of Object.entries(protocolsMetadata ?? {})) {
    if (typeof item?.gecko_id !== "string" || !item.gecko_id.trim()) continue;
    const geckoId = item.gecko_id.trim().toLowerCase();
    const previous = extrasByGeckoId.get(geckoId) ?? {};
    extrasByGeckoId.set(geckoId, {
      ...previous,
      ...(shouldPreferProtocolId(previous.protocolId, protocolId) ? { protocolId } : {}),
      ...(item?.tokenRights ? { tokenRights: true } : {}),
    });
  }

  for (const item of Object.values(chainsMetadata ?? {})) {
    if (typeof item?.gecko_id !== "string" || !item.gecko_id.trim()) continue;
    const geckoId = item.gecko_id.trim().toLowerCase();
    const previous = extrasByGeckoId.get(geckoId) ?? {};
    extrasByGeckoId.set(geckoId, {
      ...previous,
      ...(previous.chainId || typeof item?.id !== "string" || !item.id ? {} : { chainId: item.id }),
      ...(item?.tokenRights ? { tokenRights: true } : {}),
    });
  }

  return extrasByGeckoId;
};

export const getTokenExtras = (item: any, extrasByGeckoId: Map<string, any>, tokenRightsSymbols: Set<string>) => {
  const extras = extrasByGeckoId.get(getCoingeckoId(item.token_nk)!) ?? {};
  if (!tokenRightsSymbols.size || extras.tokenRights) return extras;
  const symbol = String(item?.symbol ?? "")
    .trim()
    .toLowerCase();
  if (!tokenRightsSymbols.has(symbol)) return extras;
  return { ...extras, tokenRights: true };
};

const loadPreviousTokens = async (): Promise<[string, any][]> => {
  const previousData = await readRouteData(OUTPUT_ROUTE, { skipErrorLog: true });
  if (!previousData || typeof previousData !== "object") return [];
  const previousEntries: [string, any][] = [];
  for (const [key, item] of Object.entries(previousData) as [string, any][]) {
    if (typeof item?.token_nk !== "string" || item.token_nk.length === 0) continue;
    previousEntries.push([key, item]);
  }
  return previousEntries;
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const getUniqueKey = (item: any, index: number, existingKeys: Set<string>) => {
  const symbolSlug = slug(item.symbol);
  const nameSlug = slug(item.name);
  const fallbackId = slug(item.token_nk) || `token-${index + 1}`;

  if (symbolSlug && !existingKeys.has(symbolSlug)) return symbolSlug;
  if (nameSlug && !existingKeys.has(nameSlug)) return nameSlug;

  let uniqueKey = `${nameSlug || symbolSlug || "token"}-${fallbackId}`;
  let suffix = 2;
  while (existingKeys.has(uniqueKey)) {
    uniqueKey = `${nameSlug || symbolSlug || "token"}-${fallbackId}-${suffix}`;
    suffix++;
  }
  return uniqueKey;
};

export const getTokenRouteForKey = (key: string, item: any) => {
  if (key === slug(item.symbol)) return `/token/${encodeURIComponent(item.symbol)}`;
  if (key === slug(item.name)) return `/token/${encodeURIComponent(item.name)}`;
  return `/token/${encodeURIComponent(key)}`;
};

export const createTokenRecord = (item: any, route: string, extras: any = {}) => ({
  name: item.name,
  symbol: item.symbol,
  token_nk: item.token_nk,
  route,
  is_yields: Boolean(item.on_yields),
  mcap_rank: item.mcap_rank,
  logo: getTokenLogo(item.token_nk),
  ...extras,
});

export const addPreviousTokensToRouteRegistry = (
  registry: TokenRouteRegistry,
  previousTokens: [string, any][]
): TokenRouteRegistry => {
  for (const [key, item] of previousTokens) {
    const tokenNk = item.token_nk;
    if (registry[tokenNk]) continue;
    registry[tokenNk] = {
      key,
      route: item.route ?? getTokenRouteForKey(key, item),
    };
  }
  return registry;
};

const loadTokenRouteRegistry = async (previousTokens: [string, any][]): Promise<TokenRouteRegistry> => {
  const registryData = await readRouteData(TOKEN_ROUTES_ROUTE, { skipErrorLog: true });
  const registry: TokenRouteRegistry = {};

  if (registryData && typeof registryData === "object") {
    for (const tokenNk in registryData as Record<string, any>) {
      const item = (registryData as Record<string, any>)[tokenNk];
      if (typeof item?.key !== "string" || typeof item?.route !== "string") continue;
      registry[tokenNk] = { key: item.key, route: item.route };
    }
  }

  return addPreviousTokensToRouteRegistry(registry, previousTokens);
};

export const buildTokenDirectory = (
  uniqueCoins: any[],
  nextTokensByTokenNk: Map<string, { item: any; extras: any }>,
  previousTokens: [string, any][],
  routeRegistry: TokenRouteRegistry
): TokenDirectoryBuildResult => {
  const bySlug: Record<string, any> = {};
  const seenKeys = new Set<string>();
  const routeRegistryKeys = new Set<string>();
  const consumedTokenNks = new Set<string>();
  const previousTokensByTokenNk = new Map<string, any>();
  let nameFallbackCount = 0;
  let preservedMissingTokenCount = 0;
  let reservedRouteCount = 0;
  let skippedDuplicateRouteKeyCount = 0;

  for (const [key, previousItem] of previousTokens) {
    previousTokensByTokenNk.set(previousItem.token_nk, previousItem);
    seenKeys.add(key);
  }

  for (const tokenNk in routeRegistry) {
    const routeEntry = routeRegistry[tokenNk];
    if (routeRegistryKeys.has(routeEntry.key)) {
      consumedTokenNks.add(tokenNk);
      skippedDuplicateRouteKeyCount++;
      continue;
    }
    routeRegistryKeys.add(routeEntry.key);
    seenKeys.add(routeEntry.key);

    const nextToken = nextTokensByTokenNk.get(tokenNk);
    if (nextToken) {
      bySlug[routeEntry.key] = createTokenRecord(nextToken.item, routeEntry.route, nextToken.extras);
      consumedTokenNks.add(tokenNk);
      continue;
    }

    const previousItem = previousTokensByTokenNk.get(tokenNk);
    if (previousItem) {
      bySlug[routeEntry.key] = { ...previousItem, route: routeEntry.route };
      preservedMissingTokenCount++;
      continue;
    }

    reservedRouteCount++;
  }

  for (const [index, item] of uniqueCoins.entries()) {
    if (consumedTokenNks.has(item.token_nk)) continue;

    const symbolSlug = slug(item.symbol);
    const key = getUniqueKey(item, index, seenKeys);
    const extras = nextTokensByTokenNk.get(item.token_nk)?.extras ?? {};

    if (key !== symbolSlug) nameFallbackCount++;

    const route = getTokenRouteForKey(key, item);
    routeRegistry[item.token_nk] = { key, route };
    bySlug[key] = createTokenRecord(item, route, extras);
    seenKeys.add(key);
  }

  return {
    bySlug,
    routeRegistry,
    nameFallbackCount,
    preservedMissingTokenCount,
    reservedRouteCount,
    skippedDuplicateRouteKeyCount,
  };
};

async function generateToken() {
  const [coins, protocolsMetadata, chainsMetadata, tokenRightsData] = await Promise.all([
    fetchJson(SOURCE_URL),
    readRouteData(PROTOCOLS_URL),
    readRouteData(CHAINS_URL),
    readRouteData(TOKEN_RIGHTS_URL),
  ]);

  if (!Array.isArray(coins)) {
    throw new Error(`Expected an array from ${SOURCE_URL}`);
  }

  const extrasByGeckoId = getTokenMetadataExtrasByGeckoId(protocolsMetadata, chainsMetadata);
  const tokenRightsSymbols = getTokenRightsSymbols(tokenRightsData);
  const previousTokens = await loadPreviousTokens();
  const routeRegistry = await loadTokenRouteRegistry(previousTokens);
  const uniqueCoins: any[] = [];
  const seenTokenNks = new Set<string>();

  let skippedDuplicateTokenNkCount = 0;

  for (const item of coins) {
    if (seenTokenNks.has(item.token_nk)) {
      skippedDuplicateTokenNkCount++;
      continue;
    }
    seenTokenNks.add(item.token_nk);
    uniqueCoins.push(item);
  }

  const nextTokensByTokenNk = new Map<string, { item: any; extras: any }>();
  let includedWithoutMetadataCount = 0;
  for (const item of uniqueCoins) {
    const extras = getTokenExtras(item, extrasByGeckoId, tokenRightsSymbols);
    if (!extras.protocolId && !extras.chainId) {
      includedWithoutMetadataCount++;
    }
    nextTokensByTokenNk.set(item.token_nk, { item, extras });
  }

  const {
    bySlug,
    routeRegistry: nextRouteRegistry,
    nameFallbackCount,
    preservedMissingTokenCount,
    reservedRouteCount,
    skippedDuplicateRouteKeyCount,
  } = buildTokenDirectory(uniqueCoins, nextTokensByTokenNk, previousTokens, routeRegistry);

  await storeRouteData(OUTPUT_ROUTE, bySlug);
  await storeRouteData(TOKEN_ROUTES_ROUTE, nextRouteRegistry);

  console.log(
    `Wrote ${
      Object.keys(bySlug).length
    } tokens to ${OUTPUT_ROUTE}. Used fallback key selection for ${nameFallbackCount} tokens, Included ${includedWithoutMetadataCount} tokens without protocol/chain metadata, Skipped ${skippedDuplicateTokenNkCount} duplicate token_nk rows, Preserved ${preservedMissingTokenCount} existing tokens missing from the current feed, Reserved ${reservedRouteCount} historical token routes without token records, Skipped ${skippedDuplicateRouteKeyCount} duplicate route registry keys`
  );
}

export async function genTokenConfig() {
  setTimeout(() => {
    console.log("Running for more than 5 minutes, exiting.");
    process.exit(1);
  }, 5 * 60 * 1000);

  await runWithRuntimeLogging(generateToken, {
    application: "cron-task",
    type: "generate-token",
  })
    .catch(console.error)
    .then(() => process.exit(0));
}
