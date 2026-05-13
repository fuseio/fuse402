# Fuse402 — Fuse Network Business Payments & Loyalty API (x402)

Pay-per-request access to Fuse Network blockchain data and business payment
infrastructure. Settles in USDC on Base via the [x402 protocol](https://x402.org)
— payable from any x402 client, including the
[Solid Agent Wallet](https://solid.xyz) and the
[Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/welcome).

## Live Deployment

- **URL**: https://ai.fuse.io
- **Settlement network**: Base mainnet (eip155:8453)
- **Payment token**: USDC
- **Data network**: Fuse mainnet (chain 122) via [explorer.fuse.io](https://explorer.fuse.io) Blockscout + viem

## Endpoints

| Method | Path | Price | Description |
| --- | --- | --- | --- |
| GET | `/api/fuse/stats` | $0.01 | Real-time Fuse network statistics from Blockscout. |
| GET | `/api/fuse/wallet/:address` | $0.05 | Balance, tx count, token-transfer count, last activity for any Fuse wallet. |
| GET | `/api/fuse/defi/opportunities` | $0.10 | Live Fuse-chain DeFi products (DefiLlama TVL + Solid.xyz APY windows). |
| POST | `/api/fuse/loyalty/create` | $5.00 | Deploys a real `LoyaltyToken` ERC-20 (mintable, burnable, owner + minter ACL) on Fuse via viem. **Caller is the owner.** |
| POST | `/api/fuse/loyalty/mint` | $0.50 | Mints additional units of an existing `LoyaltyToken` (requires the deployer still holds the minter role). |
| GET | `/api/fuse/loyalty/balance/:token/:address` | $0.02 | Reads any Fuse ERC-20 balance via viem. |

Free routes:

- `GET /health` — health check
- `GET /openapi.json` — OpenAPI 3.1.0 spec (x402scan-compatible)
- `GET /.well-known/x402` — well-known v1 discovery fallback

### Loyalty token custody

`/loyalty/create` deploys a token on the caller's behalf:

- The caller's `owner` address (passed in the request body) becomes the
  on-chain owner and receives the initial supply.
- This service's deployer wallet is seeded as an initial **minter** so
  `/loyalty/mint` works out of the box.
- The owner can revoke the server's mint privilege at any time by calling
  `setMinter(deployerAddress, false)` on the token contract. After that,
  `/loyalty/mint` will revert for that token.

This service never holds the owner role and cannot transfer ownership,
pause, or burn caller-owned tokens.

## Tech stack

- TypeScript on Node 20+ (run with [`tsx`](https://github.com/privatenumber/tsx))
- [express](https://expressjs.com/) 5.x
- [@x402/express](https://www.npmjs.com/package/@x402/express) — x402 middleware
- [@x402/core](https://www.npmjs.com/package/@x402/core) + [@coinbase/x402](https://www.npmjs.com/package/@coinbase/x402) — CDP facilitator client
- [viem](https://viem.sh) — Fuse RPC + ERC-20 reads/writes + contract deployment
- [zod](https://zod.dev) — request validation
- Blockscout REST API at `explorer.fuse.io`, DefiLlama, Solid Analytics

## Local development

1. Copy `.env.example` to `.env` and fill in:
   - `PAY_TO_WALLET` — wallet that receives x402 USDC payments on Base.
   - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — Coinbase CDP credentials (https://portal.cdp.coinbase.com).
   - `DEPLOYER_PRIVATE_KEY` — Fuse-mainnet EOA used to deploy loyalty tokens and mint on the caller's behalf. Needs a small FUSE balance for gas.
2. Install + run:

   ```bash
   pnpm install
   pnpm dev          # tsx watch
   pnpm test         # patches/extensions-forward smoke test
   pnpm build        # tsc --noEmit (typecheck only)
   ```

`pnpm start` runs the same TypeScript entry under `tsx` without a build
step.

## Deployment

Deployed on Vercel behind the `ai.fuse.io` custom domain. Configure all
secrets as Vercel environment variables for the Production environment —
nothing is hardcoded in `vercel.json`.

Entry point: `src/index.ts` (compiled by `@vercel/node`).

## Usage

Use any x402-compatible client. Each protected route returns a 402
challenge until a valid `X-PAYMENT` header is presented. Example with
`curl` (you'll see the 402 challenge body):

```bash
curl -i https://ai.fuse.io/api/fuse/stats
```

For real consumption use a wallet-aware client such as the
[Solid Agent Wallet](https://solid.xyz) or the
[Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/welcome) — both sign the
402 challenge and resend automatically, settling in USDC on Base. Any
other agent framework with x402 support works too.
