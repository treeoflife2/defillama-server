import {
  addPreviousTokensToRouteRegistry,
  buildTokenDirectory,
  createTokenRecord,
  getTokenExtras,
  getTokenRightsSymbols,
  getTokenRouteForKey,
} from "./generateToken";

describe("generateToken token rights flags", () => {
  it("marks token-rights rows by token symbol when protocol metadata is missing", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP", "sBP"] }]);

    expect(getTokenExtras({ symbol: "BP", token_nk: "coingecko:backpack" }, new Map(), tokenRightsSymbols)).toEqual({
      tokenRights: true,
    });
  });

  it("does not mark tokens whose symbol is missing from token-rights rows", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(
      getTokenExtras(
        { symbol: "BPT", token_nk: "coingecko:balancer-pool-token" },
        new Map([["balancer-pool-token", { protocolId: "balancer" }]]),
        tokenRightsSymbols
      )
    ).toEqual({ protocolId: "balancer" });
  });

  it("returns existing tokenRights extras without overwriting", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);
    const extras = { tokenRights: true };

    expect(
      getTokenExtras(
        { symbol: "BP", token_nk: "coingecko:backpack" },
        new Map([["backpack", extras]]),
        tokenRightsSymbols
      )
    ).toBe(extras);
  });

  it("merges tokenRights with existing protocol and chain metadata", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(
      getTokenExtras(
        { symbol: "BP", token_nk: "coingecko:backpack" },
        new Map([["backpack", { protocolId: "4266", chainId: "backpack" }]]),
        tokenRightsSymbols
      )
    ).toEqual({ protocolId: "4266", chainId: "backpack", tokenRights: true });
  });

  it("returns extras when symbol is missing", () => {
    const tokenRightsSymbols = getTokenRightsSymbols([{ Token: ["BP"] }]);

    expect(getTokenExtras({ token_nk: "coingecko:backpack" }, new Map(), tokenRightsSymbols)).toEqual({});
  });
});

describe("generateToken token routes", () => {
  it("uses the symbol route only when the stable key is the symbol slug", () => {
    expect(getTokenRouteForKey("data", { name: "Data Network", symbol: "DATA" })).toBe("/token/DATA");
  });

  it("uses the token name route when the stable key is the name slug", () => {
    expect(getTokenRouteForKey("streamr", { name: "Streamr", symbol: "DATA" })).toBe("/token/Streamr");
  });

  it("uses the unique key as the route when symbol and name keys are already occupied", () => {
    expect(getTokenRouteForKey("data-coingecko-data-hedge", { name: "DATA", symbol: "DATA" })).toBe(
      "/token/data-coingecko-data-hedge"
    );
  });

  it("keeps an already assigned route when refreshing a token record", () => {
    const record = createTokenRecord(
      {
        name: "Higher Ranked DATA",
        symbol: "DATA",
        token_nk: "coingecko:story-2",
        on_yields: true,
        mcap_rank: 10,
      },
      "/token/DATA"
    );

    expect(record).toMatchObject({
      name: "Higher Ranked DATA",
      symbol: "DATA",
      token_nk: "coingecko:story-2",
      route: "/token/DATA",
      is_yields: true,
      mcap_rank: 10,
    });
  });

  it("bootstraps immutable route ownership from the existing token cache", () => {
    const registry = addPreviousTokensToRouteRegistry(
      {
        "coingecko:streamr": {
          key: "streamr",
          route: "/token/Streamr",
        },
      },
      [
        [
          "data",
          {
            name: "Data Network",
            symbol: "DATA",
            token_nk: "coingecko:story-2",
            route: "/token/DATA",
          },
        ],
      ]
    );

    expect(registry).toEqual({
      "coingecko:streamr": {
        key: "streamr",
        route: "/token/Streamr",
      },
      "coingecko:story-2": {
        key: "data",
        route: "/token/DATA",
      },
    });
  });

  it("does not overwrite an existing route registry entry from token cache data", () => {
    const registry = addPreviousTokensToRouteRegistry(
      {
        "coingecko:story-2": {
          key: "data",
          route: "/token/DATA",
        },
      },
      [
        [
          "story",
          {
            name: "Data Network",
            symbol: "DATA",
            token_nk: "coingecko:story-2",
            route: "/token/Data%20Network",
          },
        ],
      ]
    );

    expect(registry["coingecko:story-2"]).toEqual({
      key: "data",
      route: "/token/DATA",
    });
  });

  it("keeps dead route keys reserved and gives a new same-symbol token a fallback route", () => {
    const liveToken = {
      name: "Data Network",
      symbol: "DATA",
      token_nk: "coingecko:live-data",
      mcap_rank: 100,
    };
    const routeRegistry = {
      "coingecko:dead-data": {
        key: "data",
        route: "/token/DATA",
      },
    };

    const result = buildTokenDirectory(
      [liveToken],
      new Map([["coingecko:live-data", { item: liveToken, extras: {} }]]),
      [],
      routeRegistry
    );

    expect(result.bySlug.data).toBeUndefined();
    expect(result.bySlug["data-network"]).toMatchObject({
      name: "Data Network",
      symbol: "DATA",
      token_nk: "coingecko:live-data",
      route: "/token/Data%20Network",
    });
    expect(result.routeRegistry["coingecko:dead-data"]).toEqual({
      key: "data",
      route: "/token/DATA",
    });
    expect(result.routeRegistry["coingecko:live-data"]).toEqual({
      key: "data-network",
      route: "/token/Data%20Network",
    });
    expect(result.reservedRouteCount).toBe(1);
    expect(result.nameFallbackCount).toBe(1);
  });

  it("skips duplicate registry keys instead of re-keying the second owner", () => {
    const firstToken = {
      name: "DATA",
      symbol: "DATA",
      token_nk: "coingecko:first-data",
      mcap_rank: 1000,
    };
    const secondToken = {
      name: "Second DATA",
      symbol: "DATA",
      token_nk: "coingecko:second-data",
      mcap_rank: 10,
    };
    const routeRegistry = {
      "coingecko:first-data": {
        key: "data",
        route: "/token/DATA",
      },
      "coingecko:second-data": {
        key: "data",
        route: "/token/Second%20DATA",
      },
    };

    const result = buildTokenDirectory(
      [firstToken, secondToken],
      new Map([
        ["coingecko:first-data", { item: firstToken, extras: {} }],
        ["coingecko:second-data", { item: secondToken, extras: {} }],
      ]),
      [],
      routeRegistry
    );

    expect(result.bySlug.data).toMatchObject({
      token_nk: "coingecko:first-data",
      route: "/token/DATA",
    });
    expect(result.bySlug["second-data"]).toBeUndefined();
    expect(result.routeRegistry["coingecko:second-data"]).toEqual({
      key: "data",
      route: "/token/Second%20DATA",
    });
    expect(result.skippedDuplicateRouteKeyCount).toBe(1);
  });
});
