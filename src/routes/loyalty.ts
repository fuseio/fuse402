import type { Request, Response } from "express";
import {
  formatUnits,
  getAddress as toChecksum,
  parseUnits,
  type Address,
} from "viem";
import { z } from "zod";

import {
  ERC20_READ_ABI,
  LOYALTY_TOKEN_ABI,
  LOYALTY_TOKEN_BYTECODE,
} from "../contracts/loyalty-token.js";
import {
  deployerAccount,
  publicClient,
  walletClient,
} from "../clients/viem.js";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const CreateBodySchema = z.object({
  tokenName: z.string().min(1).max(64),
  tokenSymbol: z.string().min(1).max(12),
  // Caller's wallet address — becomes the on-chain `owner` of the deployed
  // token. Required so the caller (not this service's deployer key) holds
  // the only admin role. See loyalty-token.ts for the custody model.
  owner: z.string().regex(EVM_ADDRESS),
  businessName: z.string().min(1).max(120).optional(),
  initialSupply: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
});

const MintBodySchema = z.object({
  tokenAddress: z.string().regex(EVM_ADDRESS),
  recipient: z.string().regex(EVM_ADDRESS),
  amount: z.coerce.number().positive().max(1_000_000_000),
  reason: z.string().min(1).max(120).optional(),
});

const BalanceParamsSchema = z.object({
  token: z.string().regex(EVM_ADDRESS),
  address: z.string().regex(EVM_ADDRESS),
});

function badRequest(res: Response, err: z.ZodError) {
  res.status(400).json({
    error: "invalid_request",
    issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

// POST /api/fuse/loyalty/create — deploys a fresh LoyaltyToken on Fuse on
// behalf of the caller. The caller-supplied `owner` address is set as the
// on-chain owner AND receives the initial supply; the deployer address
// (this service's DEPLOYER_PRIVATE_KEY) is seeded as an initial minter so
// /api/fuse/loyalty/mint can serve subsequent mints. The owner can revoke
// the server's minter role on-chain at any time via
// setMinter(deployerAddress, false).
export async function loyaltyCreateHandler(req: Request, res: Response) {
  const parsed = CreateBodySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { tokenName, tokenSymbol, owner, businessName, initialSupply } =
    parsed.data;

  try {
    const supplyWei = parseUnits(String(initialSupply ?? 0), 18);
    const txHash = await walletClient.deployContract({
      abi: LOYALTY_TOKEN_ABI,
      bytecode: LOYALTY_TOKEN_BYTECODE,
      args: [
        tokenName,
        tokenSymbol,
        supplyWei,
        toChecksum(owner) as Address,
        deployerAccount.address,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (!receipt.contractAddress) {
      throw new Error("deployment receipt has no contractAddress");
    }

    res.json({
      success: true,
      tokenAddress: toChecksum(receipt.contractAddress),
      tokenName,
      tokenSymbol,
      businessName: businessName ?? null,
      owner: toChecksum(owner),
      initialMinter: deployerAccount.address,
      totalSupply: supplyWei.toString(),
      decimals: 18,
      deployerAddress: deployerAccount.address,
      transactionHash: txHash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: Number(receipt.gasUsed),
      explorerUrl: `https://explorer.fuse.io/address/${receipt.contractAddress}`,
      contractFeatures: ["mintable", "burnable", "ownable", "minter-acl"],
      network: "Fuse mainnet (chain 122)",
      note:
        "The owner can revoke this service's mint privilege at any time by calling setMinter(" +
        deployerAccount.address +
        ", false) on the token contract.",
    });
  } catch (err) {
    res.status(502).json({
      error: "deployment_failed",
      message: (err as Error).message,
    });
  }
}

// POST /api/fuse/loyalty/mint — mints additional units of an existing
// LoyaltyToken. The deployer key must currently hold the MINTER role on
// the target token. Tokens created through /api/fuse/loyalty/create are
// seeded with the deployer as a minter at deploy time; if the owner has
// since called setMinter(deployerAddress, false), this call will revert.
export async function loyaltyMintHandler(req: Request, res: Response) {
  const parsed = MintBodySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { tokenAddress, recipient, amount, reason } = parsed.data;

  try {
    const decimals = await readDecimals(tokenAddress as Address);
    const amountWei = parseUnits(String(amount), decimals);

    const txHash = await walletClient.writeContract({
      address: tokenAddress as Address,
      abi: LOYALTY_TOKEN_ABI,
      functionName: "mint",
      args: [recipient as Address, amountWei],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") {
      throw new Error("mint transaction reverted");
    }

    res.json({
      success: true,
      transactionHash: txHash,
      tokenAddress: toChecksum(tokenAddress),
      recipient: toChecksum(recipient),
      amount,
      amountWei: amountWei.toString(),
      decimals,
      reason: reason ?? null,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: Number(receipt.gasUsed),
      explorerUrl: `https://explorer.fuse.io/tx/${txHash}`,
    });
  } catch (err) {
    res.status(502).json({
      error: "mint_failed",
      message: (err as Error).message,
    });
  }
}

// GET /api/fuse/loyalty/balance/:token/:address — reads any ERC-20 token
// balance on Fuse, not just contracts deployed by this service.
export async function loyaltyBalanceHandler(req: Request, res: Response) {
  const parsed = BalanceParamsSchema.safeParse(req.params);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { token, address } = parsed.data;

  try {
    const [raw, decimals, symbol] = await Promise.all([
      publicClient.readContract({
        address: token as Address,
        abi: ERC20_READ_ABI,
        functionName: "balanceOf",
        args: [address as Address],
      }),
      readDecimals(token as Address),
      readSymbol(token as Address).catch(() => null),
    ]);

    res.json({
      tokenAddress: toChecksum(token),
      holderAddress: toChecksum(address),
      symbol,
      decimals,
      balance: formatUnits(raw, decimals),
      balanceWei: raw.toString(),
      lastUpdate: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({
      error: "balance_read_failed",
      message: (err as Error).message,
    });
  }
}

async function readDecimals(token: Address): Promise<number> {
  const d = await publicClient.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "decimals",
  });
  return Number(d);
}

async function readSymbol(token: Address): Promise<string> {
  const s = await publicClient.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "symbol",
  });
  return String(s);
}
