// DefiLlama public API client. No key required.
// Endpoint reference: https://api-docs.defillama.com/
//
// Schemas are intentionally loose (`unknown` for unused fields) so DefiLlama
// adding new keys to /protocols doesn't break us. Required fields are
// asserted strictly because callers depend on them.

import { z } from "zod";

import {
  DEFILLAMA_CHAINS_URL,
  DEFILLAMA_PROTOCOLS_URL,
} from "../config.js";

const ProtocolSchema = z.object({
  name: z.string(),
  slug: z.string(),
  category: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  chains: z.array(z.string()),
  tvl: z.number().nullable().optional(),
});

// DefiLlama returns chainId as either number or string depending on the
// chain (some entries are stringified). Accept both — we don't read it
// anyway, but zod rejects the whole array if any entry mismatches.
const ChainSchema = z.object({
  name: z.string(),
  chainId: z.union([z.number(), z.string()]).nullable().optional(),
  tvl: z.number(),
  tokenSymbol: z.string().nullable().optional(),
});

export interface FuseChainSummary {
  name: string;
  tvl: number;
  tokenSymbol: string | null;
}

export interface FuseProtocol {
  name: string;
  slug: string;
  category: string | null;
  url: string | null;
  description: string | null;
  tvl: number;
}

export async function getFuseChainSummary(): Promise<FuseChainSummary | null> {
  const res = await fetch(DEFILLAMA_CHAINS_URL);
  if (!res.ok) throw new Error(`DefiLlama chains ${res.status}`);
  const chains = z.array(ChainSchema).parse(await res.json());
  const fuse = chains.find((c) => c.name === "Fuse");
  if (!fuse) return null;
  return {
    name: fuse.name,
    tvl: fuse.tvl,
    tokenSymbol: fuse.tokenSymbol ?? null,
  };
}

// Returns Fuse-active protocols sorted by current TVL (highest first).
// `categories` (when provided) filters to specific DefiLlama categories
// (e.g. "Yield", "Lending", "Dexs"). `limit` caps the result.
export async function getFuseProtocols(opts?: {
  categories?: string[];
  limit?: number;
  minTvl?: number;
}): Promise<FuseProtocol[]> {
  const res = await fetch(DEFILLAMA_PROTOCOLS_URL);
  if (!res.ok) throw new Error(`DefiLlama protocols ${res.status}`);
  const all = z.array(ProtocolSchema).parse(await res.json());

  const minTvl = opts?.minTvl ?? 100;
  let filtered = all.filter(
    (p) => p.chains.includes("Fuse") && (p.tvl ?? 0) >= minTvl,
  );

  if (opts?.categories && opts.categories.length > 0) {
    const set = new Set(opts.categories);
    filtered = filtered.filter((p) => p.category && set.has(p.category));
  }

  filtered.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  if (opts?.limit !== undefined) filtered = filtered.slice(0, opts.limit);

  return filtered.map((p) => ({
    name: p.name,
    slug: p.slug,
    category: p.category ?? null,
    url: p.url ?? null,
    description: p.description ?? null,
    tvl: p.tvl ?? 0,
  }));
}
