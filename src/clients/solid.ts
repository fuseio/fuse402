// Public Solid.xyz analytics endpoints used to enrich Fuse DeFi data with
// live APY for SoUSD/SoFUSE yield products. These analytics paths are
// unauthenticated; the same client also exposes authenticated endpoints
// (vault breakdown, savings summary) but those are not used here.
//
// Source of paths: Solid-Money/solid-ui (lib/api.ts).

import { z } from "zod";

import { SOLID_ANALYTICS_URL } from "../config.js";

const TotalApySchema = z.object({
  usdc: z.number(),
  fuse: z.number(),
});

const ApyWindowsSchema = z.object({
  allTime: z.number(),
  sevenDay: z.number(),
  fifteenDay: z.number(),
  thirtyDay: z.number(),
});

const ApysByVaultSchema = z.object({
  usdc: ApyWindowsSchema,
  fuse: ApyWindowsSchema,
  eth: ApyWindowsSchema.optional(),
});

export type SolidTotalApy = z.infer<typeof TotalApySchema>;
export type SolidApyWindows = z.infer<typeof ApyWindowsSchema>;
export type SolidApysByVault = z.infer<typeof ApysByVaultSchema>;

export async function getTotalApy(): Promise<SolidTotalApy> {
  const res = await fetch(
    `${SOLID_ANALYTICS_URL}/analytics/v1/yields/total-apy`,
  );
  if (!res.ok) throw new Error(`Solid total-apy ${res.status}`);
  return TotalApySchema.parse(await res.json());
}

export async function getApysByVault(): Promise<SolidApysByVault> {
  const res = await fetch(
    `${SOLID_ANALYTICS_URL}/analytics/v1/bigquery-metrics/apys`,
  );
  if (!res.ok) throw new Error(`Solid apys ${res.status}`);
  return ApysByVaultSchema.parse(await res.json());
}
