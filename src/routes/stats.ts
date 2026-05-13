import type { Request, Response } from "express";

import { getStats } from "../clients/blockscout.js";

// Maps Blockscout's stats response onto the contract advertised in the
// landing page and OpenAPI spec.
export async function statsHandler(_req: Request, res: Response) {
  try {
    const s = await getStats();
    const coinPrice = Number(s.coin_price);
    res.json({
      blockNumber: Number(s.total_blocks),
      totalTransactions: Number(s.total_transactions),
      dailyTransactions: Number(s.transactions_today),
      totalAddresses: Number(s.total_addresses),
      networkUtilization: s.network_utilization_percentage,
      averageBlockTime: s.average_block_time / 1000,
      gasPrice: s.gas_prices,
      fusePrice: coinPrice,
      coinPriceChangePercent24h: s.coin_price_change_percentage,
      marketCap: Number(s.market_cap),
      lastUpdated: new Date().toISOString(),
      dataSource: "Fuse Blockscout",
      paymentNetwork: "Base USDC",
    });
  } catch (err) {
    res.status(502).json({
      error: "upstream_unavailable",
      message: `Failed to fetch Fuse Blockscout stats: ${(err as Error).message}`,
    });
  }
}
