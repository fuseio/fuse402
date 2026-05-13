import type { Request, Response } from "express";
import { formatEther } from "viem";
import { z } from "zod";

import {
  getAddress,
  getAddressCounters,
  getAddressTransactions,
} from "../clients/blockscout.js";

const ParamsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

// /api/fuse/wallet/:address returns a real summary of the wallet from
// Blockscout. The "paymentActivity.last30Days" figure counts how many of
// the most recently returned transactions (up to ~50) fall inside a
// 30-day window — Blockscout's transactions endpoint already returns
// newest-first, so a single page is enough for typical wallets.
export async function walletHandler(req: Request, res: Response) {
  const parsed = ParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_address",
      message: "address must be a 0x-prefixed 40-hex EVM address",
    });
    return;
  }
  const { address } = parsed.data;

  try {
    const [info, counters, txs] = await Promise.all([
      getAddress(address),
      getAddressCounters(address),
      getAddressTransactions(address),
    ]);

    const fuseBalance = formatEther(BigInt(info.coin_balance));
    const rate = info.exchange_rate ? Number(info.exchange_rate) : 0;
    const usdValue = (Number(fuseBalance) * rate).toFixed(2);

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = (txs.items ?? []).filter(
      (t) => new Date(t.timestamp).getTime() >= cutoff,
    );
    const total = recent.reduce(
      (acc, t) => acc + Number(formatEther(BigInt(t.value))),
      0,
    );
    const average = recent.length > 0 ? total / recent.length : 0;
    const lastActivity = txs.items?.[0]?.timestamp ?? null;

    res.json({
      address: info.hash,
      isContract: info.is_contract,
      balance: { fuse: fuseBalance, usd: usdValue, exchangeRate: rate },
      transactionCount: Number(counters.transactions_count),
      tokenTransfersCount: Number(counters.token_transfers_count),
      gasUsageCount: Number(counters.gas_usage_count),
      hasTokenTransfers: info.has_token_transfers,
      hasTokens: info.has_tokens,
      lastActivity,
      paymentActivity: {
        last30Days: recent.length,
        averageAmount: average.toFixed(4),
      },
      lastBalanceUpdateBlock: info.block_number_balance_updated_at,
      dataSource: "Fuse Blockscout",
    });
  } catch (err) {
    res.status(502).json({
      error: "upstream_unavailable",
      message: `Failed to fetch wallet from Blockscout: ${(err as Error).message}`,
    });
  }
}
