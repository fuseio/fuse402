import type { Request, Response } from "express";

import {
  getFuseChainSummary,
  type FuseProtocol,
  getFuseProtocols,
} from "../clients/defillama.js";
import { getApysByVault, getTotalApy } from "../clients/solid.js";

// /api/fuse/defi/opportunities returns live Fuse protocol data:
//   - DefiLlama TVL for protocols deployed on Fuse, split by category
//   - Solid.xyz APY windows for SoUSD/SoFUSE yield products
//
// Categories were chosen to surface what a treasurer/business agent would
// shop for: Yield (auto-compounding strategies), Lending (borrow/supply),
// Dexs (AMM LP), Liquid Staking, CDP. CEX/Bridge entries are filtered out.
const CATEGORY_KEEP = ["Yield", "Lending", "Dexs", "Liquid Staking", "CDP"];

interface ShapedProtocol {
  name: string;
  slug: string;
  url: string | null;
  tvlUsd: number;
  description: string | null;
}

function shape(p: FuseProtocol): ShapedProtocol {
  return {
    name: p.name,
    slug: p.slug,
    url: p.url,
    tvlUsd: p.tvl,
    description: p.description,
  };
}

export async function defiOpportunitiesHandler(_req: Request, res: Response) {
  try {
    const [chain, protocols, totalApy, apys] = await Promise.all([
      getFuseChainSummary(),
      getFuseProtocols({ categories: CATEGORY_KEEP, limit: 15 }),
      getTotalApy().catch(() => null),
      getApysByVault().catch(() => null),
    ]);

    const grouped: Record<string, ShapedProtocol[]> = {};
    for (const p of protocols) {
      const cat = p.category ?? "Other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(shape(p));
    }

    res.json({
      chain: chain && {
        name: chain.name,
        tvlUsd: chain.tvl,
        nativeToken: chain.tokenSymbol,
      },
      protocols: grouped,
      solidYield:
        totalApy && apys
          ? {
              usdc: {
                currentApy: totalApy.usdc,
                windows: apys.usdc,
                description:
                  "SoUSD yield — auto-compounded across trusted DeFi protocols",
              },
              fuse: {
                currentApy: totalApy.fuse,
                windows: apys.fuse,
                description: "SoFUSE yield — native-token staking returns",
              },
            }
          : null,
      lastUpdated: new Date().toISOString(),
      dataSources: ["DefiLlama", "Solid.xyz analytics"],
    });
  } catch (err) {
    res.status(502).json({
      error: "upstream_unavailable",
      message: `Failed to fetch DeFi data: ${(err as Error).message}`,
    });
  }
}
