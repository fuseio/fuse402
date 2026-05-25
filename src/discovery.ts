// Discovery metadata for x402scan and similar consumers.
//
// Two complementary documents are served from this module:
//
//   1. OPENAPI_SPEC      → exposed at GET /openapi.json
//      Canonical, machine-readable contract following OpenAPI 3.1.0 with
//      x402scan-specific extensions:
//        - info.x-guidance: high-level prose for agents on how to use the API
//        - operation.x-payment-info: price + supported payment protocols
//        - operation.responses["402"]: declares the route is payable
//      Every paid operation MUST have both x-payment-info AND responses["402"].
//
//   2. WELLKNOWN_X402    → exposed at GET /.well-known/x402
//      Minimal fallback per x402scan well-known v1. Each entry is "METHOD /path".
//
// Runtime 402 behavior is authoritative over this static metadata — if the
// route configs in src/index.ts change, update this file to match.

import {
  HOST_URL,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  LIGHTNING_CURRENCY,
  PAY_TO,
  SFUSE_ICON_URL,
  TEMPO_CURRENCY,
} from "./config.js";
import { dollarsToSats } from "./mpp.js";

// Shared x-payment-info builder. Every paid operation needs the same shape:
//   - price: structured fixed-mode object in USD (x402scan reads this)
//   - protocols: protocol-family list (x402 + mpp). The mpp entry's
//     method/intent/currency fields must be non-empty strings or
//     @agentcash/discovery's hasImproperMppTag flags L2_MPP_MALFORMED;
//     they advertise the canonical MPP method (we use tempo since it's
//     the native MPP rail). Full per-method detail lives in offers[].
//   - offers: MPP-canonical list per registered method (tempo, stripe,
//     lightning). Matches mppx/discovery's PaymentInfo zod schema and
//     lets MPP-aware clients pre-select before issuing a request.
function paymentInfo(amountUsd: string, description: string) {
  return {
    price: { mode: "fixed", currency: "USD", amount: amountUsd },
    protocols: [
      { x402: {} },
      { mpp: { method: "tempo", intent: "charge", currency: TEMPO_CURRENCY } },
    ],
    offers: [
      {
        method: "tempo",
        intent: "charge",
        amount: amountUsd,
        currency: TEMPO_CURRENCY,
        description,
      },
      {
        method: "stripe",
        intent: "charge",
        amount: amountUsd,
        currency: "USD",
        description,
      },
      {
        method: "lightning",
        intent: "charge",
        amount: dollarsToSats(amountUsd),
        currency: LIGHTNING_CURRENCY,
        description,
      },
    ],
  };
}

const RESP_402 = { description: "Payment Required" } as const;
const EVM_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";

// Synthetic-but-truthful input parameter for GET endpoints that take no
// user input. Satisfies @agentcash/discovery's L3_INPUT_SCHEMA_MISSING
// check (every paid endpoint must declare some input schema via either
// `parameters[]` or `requestBody`) without lying about behavior — the
// endpoints really do always return application/json.
const NO_INPUT_PARAMETERS = [
  {
    name: "Accept",
    in: "header",
    required: false,
    description:
      "Standard HTTP Accept header. Endpoint always returns application/json regardless.",
    schema: { type: "string", default: "application/json" },
  },
] as const;

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: LANDING_TITLE,
    version: "1.0.0",
    description: LANDING_DESCRIPTION,
    "x-guidance":
      "Fuse AI exposes Fuse Network blockchain intelligence and business " +
      "payment tooling as pay-per-request HTTP endpoints. Six paid operations: " +
      "(1) GET /api/fuse/stats ($0.01) returns real-time Fuse Blockscout " +
      "network statistics — block number, transaction volumes, gas price tiers, " +
      "FUSE token price. " +
      "(2) GET /api/fuse/wallet/{address} ($0.05) returns balance (FUSE + USD), " +
      "transaction count, token transfer count, last activity, and 30-day " +
      "payment activity for any EVM address on Fuse. " +
      "(3) GET /api/fuse/defi/opportunities ($0.10) lists live Fuse-chain " +
      "DeFi products (TVL from DefiLlama, APY windows from Solid.xyz). " +
      "(4) POST /api/fuse/loyalty/create ($5.00) deploys a real LoyaltyToken " +
      "ERC-20 (mintable, burnable, ownable, minter-acl) on Fuse mainnet on " +
      "behalf of the caller. The body MUST include `owner` (caller's wallet " +
      "address) — that address becomes the on-chain owner and receives the " +
      "initial supply. This service's deployer key is seeded as an initial " +
      "minter so /mint works out of the box; the owner can revoke it on-chain " +
      "via setMinter(deployer, false) at any time. " +
      "(5) POST /api/fuse/loyalty/mint ($0.50) mints additional units of an " +
      "already-deployed LoyaltyToken to a recipient address. Only works while " +
      "the deployer is still in the token's minter set. " +
      "(6) GET /api/fuse/loyalty/balance/{token}/{address} ($0.02) reads any " +
      "ERC-20 balance on Fuse via viem. " +
      "Every endpoint accepts payment via two protocols simultaneously: " +
      "(a) x402 — USDC on Base mainnet (eip155:8453) settled by the Coinbase " +
      "CDP facilitator, paid to " + PAY_TO + "; or (b) MPP — Tempo USDC " +
      "(stablecoin), Stripe (Visa, Mastercard, wallets), or Bitcoin Lightning. " +
      "MPP clients read the x-payment-info.offers field on each operation, " +
      "or hit the endpoint without credentials to receive WWW-Authenticate: " +
      "Payment challenges. No accounts, no API keys — agents pay per request.",
    "x-logo": { url: SFUSE_ICON_URL, altText: "Fuse Network" },
  },
  "x-service-info": {
    categories: ["blockchain", "ai", "payments"],
    docs: {
      homepage: HOST_URL,
      apiReference: `${HOST_URL}/openapi.json`,
    },
  },
  servers: [{ url: HOST_URL, description: "Production" }],
  paths: {
    "/api/fuse/stats": {
      get: {
        operationId: "getFuseStats",
        tags: ["Network"],
        summary: "Real-time Fuse network statistics",
        description:
          "Returns current Fuse Network state from Blockscout: block number, " +
          "total and daily transactions, network utilization, gas price tiers, " +
          "FUSE token price.",
        parameters: NO_INPUT_PARAMETERS,
        "x-payment-info": paymentInfo("0.01", "Real-time Fuse network statistics"),
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
    "/api/fuse/wallet/{address}": {
      get: {
        operationId: "getFuseWallet",
        tags: ["Wallet"],
        summary: "Complete Fuse wallet analysis",
        description:
          "Returns balance (FUSE + USD), transaction count, token transfer " +
          "count, last activity timestamp, and 30-day payment activity.",
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            description: "EVM wallet address (0x-prefixed, 42 chars)",
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
        ],
        "x-payment-info": paymentInfo("0.05", "Fuse wallet analysis"),
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
    "/api/fuse/defi/opportunities": {
      get: {
        operationId: "getFuseDefiOpportunities",
        tags: ["DeFi"],
        summary: "Fuse DeFi yield opportunities",
        description:
          "Lists Fuse-chain protocols (TVL from DefiLlama, grouped by category) " +
          "plus live Solid.xyz APY windows for SoUSD/SoFUSE yield products.",
        parameters: NO_INPUT_PARAMETERS,
        "x-payment-info": paymentInfo("0.10", "Fuse DeFi yield opportunities"),
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
    "/api/fuse/loyalty/create": {
      post: {
        operationId: "createLoyaltyToken",
        tags: ["Loyalty"],
        summary: "Deploy a loyalty/payment token on Fuse",
        description:
          "Deploys a real LoyaltyToken ERC-20 (mintable, burnable, ownable, " +
          "minter-acl) on Fuse mainnet via viem on behalf of the caller. The " +
          "caller-supplied `owner` address becomes the on-chain owner and " +
          "receives the initial supply; this service's deployer is seeded as " +
          "an initial minter (revocable by owner via setMinter).",
        "x-payment-info": paymentInfo("5.00", "Deploy LoyaltyToken ERC-20 on Fuse"),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tokenName", "tokenSymbol", "owner"],
                properties: {
                  tokenName: { type: "string", maxLength: 64 },
                  tokenSymbol: { type: "string", maxLength: 12 },
                  owner: {
                    type: "string",
                    description:
                      "Caller's wallet address — becomes the on-chain token " +
                      "owner and receives the initial supply.",
                    pattern: EVM_ADDRESS_PATTERN,
                  },
                  businessName: { type: "string", maxLength: 120 },
                  initialSupply: { type: "integer", minimum: 0 },
                },
              },
              example: {
                tokenName: "AcmeRewards",
                tokenSymbol: "ACME",
                owner: "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
                businessName: "Acme Inc.",
                initialSupply: 1000000,
              },
            },
          },
        },
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
    "/api/fuse/loyalty/mint": {
      post: {
        operationId: "mintLoyaltyTokens",
        tags: ["Loyalty"],
        summary: "Mint loyalty tokens to a recipient",
        description:
          "Mints additional units of an already-deployed LoyaltyToken on " +
          "Fuse. Only succeeds while this service's deployer holds the " +
          "minter role for the target token (revocable by owner).",
        "x-payment-info": paymentInfo("0.50", "Mint loyalty tokens"),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tokenAddress", "recipient", "amount"],
                properties: {
                  tokenAddress: {
                    type: "string",
                    pattern: EVM_ADDRESS_PATTERN,
                  },
                  recipient: { type: "string", pattern: EVM_ADDRESS_PATTERN },
                  amount: { type: "number", minimum: 0 },
                  reason: { type: "string", maxLength: 120 },
                },
              },
              example: {
                tokenAddress: "0xabc1234567890abcdef1234567890abcdef12345",
                recipient: "0xdef1234567890abcdef1234567890abcdef12345",
                amount: 100,
                reason: "customer_referral_bonus",
              },
            },
          },
        },
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
    "/api/fuse/loyalty/balance/{token}/{address}": {
      get: {
        operationId: "getErc20Balance",
        tags: ["Loyalty"],
        summary: "Read any Fuse ERC-20 balance",
        description:
          "Returns the balance of a Fuse ERC-20 token held by a wallet " +
          "(reads via viem; works for any ERC-20, not just LoyaltyTokens).",
        parameters: [
          {
            name: "token",
            in: "path",
            required: true,
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
        ],
        "x-payment-info": paymentInfo("0.02", "Read ERC-20 balance on Fuse"),
        responses: { "200": { description: "OK" }, "402": RESP_402 },
      },
    },
  },
} as const;

// llms.txt — concise Markdown summary of this API for LLM consumers.
// Follows the llmstxt.org convention: H1 title, blockquote summary, then
// H2 sections with bulleted links and inline descriptions.
export const LLMS_TXT = `# ${LANDING_TITLE}

> ${LANDING_DESCRIPTION}

Six paid HTTP endpoints returning JSON. No accounts or API keys — clients pay per request via x402 (USDC on Base mainnet, eip155:8453) or MPP (Tempo USDC, Stripe Visa/Mastercard, Bitcoin Lightning). Merchant address: ${PAY_TO}.

## Network

- [Real-time Fuse network statistics](${HOST_URL}/api/fuse/stats): $0.01 — block number, daily/total transactions, gas price tiers (slow/average/fast), FUSE token price, market cap, network utilization.
- [Fuse wallet analysis](${HOST_URL}/api/fuse/wallet/{address}): $0.05 — FUSE balance (wei + formatted + USD), transaction count, token transfer count, last activity timestamp, 30-day inflow/outflow/unique counterparties. Path param: \`address\` (0x-prefixed EVM address).
- [Fuse DeFi yield opportunities](${HOST_URL}/api/fuse/defi/opportunities): $0.10 — chain TVL from DefiLlama, DeFi protocol list grouped by category, Solid.xyz APY windows for SoUSD and SoFUSE.

## Loyalty Tokens

- [Deploy LoyaltyToken ERC-20](${HOST_URL}/api/fuse/loyalty/create): $5.00 — POST \`{tokenName, tokenSymbol, owner, businessName?, initialSupply?}\`; deploys mintable/burnable/ownable ERC-20 on Fuse mainnet; returns \`tokenAddress\` + \`transactionHash\`.
- [Mint loyalty tokens](${HOST_URL}/api/fuse/loyalty/mint): $0.50 — POST \`{tokenAddress, recipient, amount, reason?}\`; mints to any address while the deployer holds the minter role.
- [Read ERC-20 balance](${HOST_URL}/api/fuse/loyalty/balance/{token}/{address}): $0.02 — returns symbol, decimals, balance (formatted + wei) for any Fuse ERC-20. Path params: \`token\`, \`address\` (both 0x-prefixed EVM addresses).

## Discovery

- [OpenAPI 3.1.0 specification](${HOST_URL}/openapi.json): Machine-readable contract with \`x-payment-info.offers\` per operation.
- [x402 well-known](${HOST_URL}/.well-known/x402): x402scan resource list (v1).
`;

// Per the x402scan well-known v1 spec, resources are "METHOD /path" strings,
// NOT full URLs or object entries. Dynamic routes keep Express :param syntax
// — x402scan normalizes these for catalog grouping.
export const WELLKNOWN_X402 = {
  version: 1,
  resources: [
    "GET /api/fuse/stats",
    "GET /api/fuse/wallet/:address",
    "GET /api/fuse/defi/opportunities",
    "POST /api/fuse/loyalty/create",
    "POST /api/fuse/loyalty/mint",
    "GET /api/fuse/loyalty/balance/:token/:address",
  ],
} as const;
