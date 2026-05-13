// viem clients for Fuse mainnet (chain 122).
//
// - publicClient: read-only RPC (balanceOf, contract introspection)
// - walletClient: signs and pays gas for loyalty-token deploys and mints.
//   The deployer key is NOT the on-chain owner of deployed tokens — the
//   caller-supplied address (passed to /loyalty/create) becomes the owner.
//   The deployer is seeded as an initial minter at deploy time so that
//   /loyalty/mint can serve subsequent mints; the owner can revoke that
//   minter role on-chain at any time via setMinter(deployer, false).

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fuse } from "viem/chains";

import { DEPLOYER_PRIVATE_KEY } from "../config.js";

// Normalize the env value to viem's 0x-prefixed Hex shape. Accept both with
// and without the 0x prefix so deployments aren't tripped up by the
// difference between Coinbase-style and OpenZeppelin-style key exports.
function normalizePrivateKey(raw: string): Hex {
  const trimmed = raw.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

export const deployerAccount = privateKeyToAccount(
  normalizePrivateKey(DEPLOYER_PRIVATE_KEY),
);

export const publicClient = createPublicClient({
  chain: fuse,
  transport: http(),
});

export const walletClient = createWalletClient({
  account: deployerAccount,
  chain: fuse,
  transport: http(),
});
