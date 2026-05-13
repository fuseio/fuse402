// Thin wrapper over the public Fuse Blockscout REST API.
// Docs: https://explorer.fuse.io/api-docs (Blockscout v6 spec).
//
// Every response is parsed through a zod schema so upstream shape drift
// surfaces at the call site (with the bad payload in the error) rather
// than as a downstream TypeError on undefined property access.

import { z } from "zod";

import { FUSE_BLOCKSCOUT_URL } from "../config.js";

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${FUSE_BLOCKSCOUT_URL}${path}`);
  if (!res.ok) {
    throw new Error(
      `Blockscout ${path} returned ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

const FuseStatsSchema = z.object({
  average_block_time: z.number(),
  coin_price: z.string(),
  coin_price_change_percentage: z.number().nullable(),
  gas_prices: z.object({
    slow: z.number(),
    average: z.number(),
    fast: z.number(),
  }),
  market_cap: z.string(),
  network_utilization_percentage: z.number(),
  total_blocks: z.string(),
  total_transactions: z.string(),
  transactions_today: z.string(),
  total_addresses: z.string(),
});
export type FuseStats = z.infer<typeof FuseStatsSchema>;

const AddressInfoSchema = z.object({
  hash: z.string(),
  coin_balance: z.string(),
  exchange_rate: z.string().nullable(),
  is_contract: z.boolean(),
  has_token_transfers: z.boolean(),
  has_tokens: z.boolean(),
  block_number_balance_updated_at: z.number().nullable(),
});
export type AddressInfo = z.infer<typeof AddressInfoSchema>;

const AddressCountersSchema = z.object({
  transactions_count: z.string(),
  gas_usage_count: z.string(),
  token_transfers_count: z.string(),
  validations_count: z.string(),
});
export type AddressCounters = z.infer<typeof AddressCountersSchema>;

const TxListSchema = z.object({
  items: z
    .array(
      z.object({
        hash: z.string(),
        timestamp: z.string(),
        value: z.string(),
        from: z.object({ hash: z.string() }).nullable(),
        to: z.object({ hash: z.string() }).nullable(),
        result: z.string(),
      }),
    )
    .default([]),
});
export type TxListResponse = z.infer<typeof TxListSchema>;

export async function getStats(): Promise<FuseStats> {
  return FuseStatsSchema.parse(await getJson("/api/v2/stats"));
}

export async function getAddress(address: string): Promise<AddressInfo> {
  return AddressInfoSchema.parse(await getJson(`/api/v2/addresses/${address}`));
}

export async function getAddressCounters(
  address: string,
): Promise<AddressCounters> {
  return AddressCountersSchema.parse(
    await getJson(`/api/v2/addresses/${address}/counters`),
  );
}

export async function getAddressTransactions(
  address: string,
): Promise<TxListResponse> {
  return TxListSchema.parse(
    await getJson(`/api/v2/addresses/${address}/transactions`),
  );
}
