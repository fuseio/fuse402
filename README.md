# Fuse AI — Fuse Network Business Payments & Loyalty API

Pay-per-request access to Fuse Network blockchain data and business payment
infrastructure. The same endpoints accept payment over **two protocols**
simultaneously:

- **x402** — USDC on Base via the [x402 protocol](https://x402.org), settled
  by the Coinbase CDP facilitator. Payable from any x402 client, including
  the [Solid Agent Wallet](https://solid.xyz) and the
  [Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/welcome).
- **MPP** ([Machine Payments Protocol](https://mpp.dev), co-authored by Tempo
  and Stripe) — three rails on one wire:
  - **Tempo** USDC (stablecoin, sub-second finality on Tempo mainnet `4217` /
    Moderato testnet `42431`)
  - **Stripe** — Visa, Mastercard, and digital wallets via Stripe Shared
    Payment Tokens
  - **Bitcoin Lightning** via [Spark](https://www.buildonspark.com/)

Both protocols cohabit a single 402 response: x402 clients read
`X-PAYMENT-REQUIRED`, MPP clients read `WWW-Authenticate: Payment` (one entry
per method). See [src/middleware/dual-pay.ts](src/middleware/dual-pay.ts) for
the dispatch + composite-challenge logic.

## Live Deployment

- **URL**: https://ai.fuse.io
- **x402 settlement**: Base mainnet (eip155:8453), USDC
- **MPP settlement**: Tempo (testnet by default), Stripe (USD), Lightning (BTC)
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
- `GET /openapi.json` — OpenAPI 3.1.0 spec. Each paid operation carries:
  - `x-payment-info.price` + `x-payment-info.protocols` (x402scan-flavored)
  - `x-payment-info.offers[]` — one entry per MPP method (tempo / stripe / lightning) so MPP-aware agents can pre-select before issuing the request
- `GET /.well-known/x402` — well-known v1 discovery fallback

Document root also exposes `x-service-info` (categories + docs links) per the
MPP discovery spec.

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
- x402 path: [@x402/express](https://www.npmjs.com/package/@x402/express),
  [@x402/core](https://www.npmjs.com/package/@x402/core),
  [@coinbase/x402](https://www.npmjs.com/package/@coinbase/x402)
- MPP path: [mppx](https://www.npmjs.com/package/mppx) (wevm),
  [stripe](https://www.npmjs.com/package/stripe),
  [@buildonspark/lightning-mpp-sdk](https://www.npmjs.com/package/@buildonspark/lightning-mpp-sdk)
- [viem](https://viem.sh) — Fuse RPC + ERC-20 reads/writes + contract deployment
- [zod](https://zod.dev) — request validation
- Blockscout REST API at `explorer.fuse.io`, DefiLlama, Solid Analytics

## Local development

1. Copy `.env.example` to `.env` and fill in the required values.

   **x402 (always required):**
   - `PAY_TO_WALLET` — wallet that receives x402 USDC payments on Base.
   - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — Coinbase CDP credentials (https://portal.cdp.coinbase.com).
   - `DEPLOYER_PRIVATE_KEY` — Fuse-mainnet EOA used to deploy loyalty tokens and mint on the caller's behalf. Needs a small FUSE balance for gas.

   **MPP (required when `MPP_ENABLED=true`, which is the default):**
   - `MPP_SECRET_KEY` — HMAC key binding challenge IDs to contents. Generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Treat as root-of-trust.
   - `TEMPO_PAY_TO` — recipient address on Tempo (testnet Moderato or mainnet, selected by `TEMPO_TESTNET`).
   - `STRIPE_SECRET_KEY` — `sk_test_…` for development, `sk_live_…` in prod. Stripe account must have machine payments enabled.
   - `STRIPE_NETWORK_ID` — Business Network profile ID from the Stripe Dashboard.
   - `BTC_MNEMONIC` — server-side Spark wallet seed for Lightning. Use `BTC_NETWORK=regtest` for local dev (free), `signet` for public testnet, `mainnet` for real BTC.

   To ship MPP code dark, set `MPP_ENABLED=false` — all MPP env vars become
   optional and the server runs in x402-only mode (current production behavior).

2. Install + run:

   ```bash
   pnpm install
   pnpm dev          # tsx watch
   pnpm test         # patches/extensions-forward smoke test
   pnpm build        # tsc --noEmit (typecheck only)
   ```

`pnpm start` runs the same TypeScript entry under `tsx` without a build
step.

## Funding wallets

**x402 (Base USDC)** — fund `PAY_TO_WALLET` with USDC on Base for receiving;
no inbound funding needed (clients pay you).

**Tempo testnet (Moderato, chain 42431)** — get free test stablecoins
(pathUSD / AlphaUSD / BetaUSD / ThetaUSD) for any address at
[docs.tempo.xyz/quickstart/faucet](https://docs.tempo.xyz/quickstart/faucet).

**Tempo mainnet (chain 4217)** — bridge USDC from Ethereum / Base / Arbitrum
/ Optimism / Polygon via [relay.link/bridge](https://relay.link/bridge). The
default mainnet token is USDC.e at `0x20C000000000000000000000b9537d11c60E8b50`.

**Stripe** — no wallet, payments land directly in the connected Stripe
account.

**Lightning** — for testing, use the Spark testnet faucet; for production,
the server's Spark wallet (seeded by `BTC_MNEMONIC`) needs no inbound balance
since each payment generates a fresh BOLT11 invoice paid by the client.

## Deployment

Deployed on Vercel behind the `ai.fuse.io` custom domain. Configure all
secrets as Vercel environment variables for the Production environment —
nothing is hardcoded in `vercel.json`.

Entry point: `src/index.ts` (compiled by `@vercel/node`).

## Usage

### x402 client

Each protected route returns a 402 challenge until a valid `X-PAYMENT`
header is presented. Example with `curl`:

```bash
curl -i https://ai.fuse.io/api/fuse/stats
```

For real consumption use a wallet-aware client such as the
[Solid Agent Wallet](https://solid.xyz) or the
[Coinbase Agentic Wallet](https://docs.cdp.coinbase.com/agentic-wallet/welcome) —
both sign the 402 challenge and resend automatically, settling in USDC on Base.

### MPP client

MPP clients read the `WWW-Authenticate: Payment …` headers on the 402, pick
a method, sign a credential, and resend with `Authorization: Payment …`. The
[`mppx`](https://www.npmjs.com/package/mppx) CLI does this automatically:

```bash
npx mppx pay https://ai.fuse.io/api/fuse/stats
```

Discovery: agents can fetch `/openapi.json` and pre-select a method from
`x-payment-info.offers[]` before issuing the request, avoiding the
challenge round-trip.

## Architecture

```
                ┌──────────────────────────────────┐
   request ───▶│  src/middleware/dual-pay.ts       │
                │                                   │
                │  ┌─ Authorization: Payment        │
                │  │   → mpp.compose() verify       │
                │  │   → req.__mppPaid = true       │
                │  │                                │
                │  ├─ X-PAYMENT                     │
                │  │   → next() (let x402 run)      │
                │  │                                │
                │  └─ (no creds)                    │
                │      → pre-build MPP challenges,  │
                │        hook res.writeHead to add  │
                │        WWW-Authenticate on 402    │
                └─────────────┬────────────────────┘
                              │ next()
                              ▼
                ┌──────────────────────────────────┐
                │  @x402/express paymentMiddleware │
                │  (skipped if __mppPaid)          │
                └─────────────┬────────────────────┘
                              │ paid?
                              ▼
                ┌──────────────────────────────────┐
                │  route handler (stats / wallet / │
                │  defi / loyalty.*)               │
                └──────────────────────────────────┘
```

Single source of truth for the route → price table lives in
[`PAID_ROUTES`](src/index.ts) at the top of `src/index.ts`.
