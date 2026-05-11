"use strict";

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
//      Per-operation requestBody.content["application/json"].schema captures
//      input shape for reliable agent invocation.
//
//   2. WELLKNOWN_X402    → exposed at GET /.well-known/x402
//      Minimal fallback per x402scan well-known v1. Each entry is "METHOD /path"
//      (NOT a full URL or object — current x402scan docs use the verb-path
//      form even though older drafts of the spec showed full URLs).
//
// OpenAPI is canonical and x402scan selects it when present; well-known is
// shipped alongside as belt-and-suspenders. Both are served unauthenticated.
//
// Runtime 402 behavior is authoritative over this static metadata — if the
// route configs in index.js change, update this file to match.

const HOST = "https://fuse402.vercel.app";
const PAYEE = "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9";

// Shared x-payment-info builder. Every paid operation needs the same shape:
//   - price: structured fixed-mode object in USD
//   - protocols: array advertising x402 (primary) and mpp (multi-party
//     payments; fields intentionally empty per current x402scan spec example)
function paymentInfo(amountUsd) {
  return {
    price: { mode: "fixed", currency: "USD", amount: amountUsd },
    protocols: [
      { x402: {} },
      { mpp: { method: "", intent: "", currency: "" } },
    ],
  };
}

// Shared 402 response shape. All paid operations declare it identically.
const RESP_402 = { description: "Payment Required" };

// EVM 20-byte address regex, used for path params and request-body addresses.
const EVM_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Fuse402: Business Payments & Loyalty API",
    version: "1.0.0",
    description:
      "Pay-per-request access to Fuse Network blockchain data and business " +
      "payment infrastructure. Settles in USDC on Base via x402.",
    "x-guidance":
      "Fuse402 exposes Fuse Network blockchain intelligence and business " +
      "payment tooling as pay-per-request HTTP endpoints. Six paid operations: " +
      "(1) GET /api/fuse/stats ($0.01) returns real-time network statistics — " +
      "block number, transaction volumes, gas price tiers, FUSE token price. " +
      "(2) GET /api/fuse/wallet/{address} ($0.05) returns balance (FUSE + USD), " +
      "transaction count, last activity, DeFi positions, and 30-day payment " +
      "activity for any EVM address on Fuse. " +
      "(3) GET /api/fuse/defi/opportunities ($0.10) lists current business " +
      "savings and lending products on Fuse with APYs and minimum deposits. " +
      "(4) POST /api/fuse/loyalty/create ($5.00) deploys a new loyalty or " +
      "payment ERC-20 token (mintable/burnable/pausable) and returns the " +
      "contract address and tx hash. " +
      "(5) POST /api/fuse/loyalty/mint ($0.50) mints additional loyalty tokens " +
      "from an already-deployed contract to a recipient address. " +
      "(6) GET /api/fuse/loyalty/balance/{token}/{address} ($0.02) returns the " +
      "balance of a specific loyalty token held by a wallet. " +
      "All endpoints settle in USDC on Base mainnet (eip155:8453) via the " +
      "x402 protocol, paid to " + PAYEE + ". " +
      "No accounts, no API keys — agents pay per request from any wallet.",
  },
  servers: [{ url: HOST, description: "Production" }],
  paths: {
    "/api/fuse/stats": {
      get: {
        summary: "Real-time Fuse network statistics",
        description:
          "Returns current Fuse Network state: block number, total and daily " +
          "transactions, network utilization, gas price tiers, FUSE token price.",
        "x-payment-info": paymentInfo("0.01"),
        responses: {
          "200": {
            description: "Network statistics snapshot",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    blockNumber: { type: "integer" },
                    totalTransactions: { type: "integer" },
                    dailyTransactions: { type: "integer" },
                    networkUtilization: { type: "number" },
                    averageBlockTime: { type: "number" },
                    gasPrice: {
                      type: "object",
                      properties: {
                        slow: { type: "number" },
                        average: { type: "number" },
                        fast: { type: "number" },
                      },
                    },
                    fusePrice: { type: "number" },
                    marketCap: { type: "number" },
                    lastUpdated: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
    "/api/fuse/wallet/{address}": {
      get: {
        summary: "Complete Fuse wallet analysis",
        description:
          "Returns balance (FUSE + USD), transaction count, last activity " +
          "timestamp, DeFi positions, and 30-day payment activity for a wallet.",
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            description: "EVM wallet address (0x-prefixed, 42 chars)",
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
        ],
        "x-payment-info": paymentInfo("0.05"),
        responses: {
          "200": {
            description: "Wallet analysis",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    balance: {
                      type: "object",
                      properties: {
                        fuse: { type: "string" },
                        usd: { type: "string" },
                      },
                    },
                    transactionCount: { type: "integer" },
                    lastActivity: { type: "string", format: "date-time" },
                    defiPositions: { type: "array", items: {} },
                    paymentActivity: {
                      type: "object",
                      properties: {
                        last30Days: { type: "integer" },
                        averageAmount: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
    "/api/fuse/defi/opportunities": {
      get: {
        summary: "Fuse DeFi yield opportunities",
        description:
          "Lists current business savings accounts and lending products on " +
          "Fuse Network, with APYs, minimum deposits, and protocol details.",
        "x-payment-info": paymentInfo("0.10"),
        responses: {
          "200": {
            description: "DeFi opportunities snapshot",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    savingsAccounts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          protocol: { type: "string" },
                          apy: { type: "string" },
                          asset: { type: "string" },
                          minimumDeposit: { type: "number" },
                          description: { type: "string" },
                        },
                      },
                    },
                    businessLoans: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          protocol: { type: "string" },
                          rate: { type: "string" },
                          maxAmount: { type: "number" },
                          collateral: { type: "string" },
                          description: { type: "string" },
                        },
                      },
                    },
                    lastUpdated: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
    "/api/fuse/loyalty/create": {
      post: {
        summary: "Deploy a loyalty/payment token on Fuse",
        description:
          "Deploys a new ERC-20 token with loyalty/payment features " +
          "(mintable, burnable, pausable) on Fuse Network. Returns the " +
          "deployed contract address and deployment transaction hash.",
        "x-payment-info": paymentInfo("5.00"),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tokenName", "tokenSymbol"],
                properties: {
                  tokenName: {
                    type: "string",
                    description: "Display name of the token",
                  },
                  tokenSymbol: {
                    type: "string",
                    description: "Ticker symbol (3-6 chars typical)",
                    maxLength: 12,
                  },
                  businessName: {
                    type: "string",
                    description: "Issuing business name",
                  },
                  initialSupply: {
                    type: "integer",
                    description: "Initial mint amount in whole tokens",
                    minimum: 1,
                  },
                },
              },
              example: {
                tokenName: "AcmeRewards",
                tokenSymbol: "ACME",
                businessName: "Acme Inc.",
                initialSupply: 1000000,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Token deployed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    tokenAddress: { type: "string" },
                    tokenName: { type: "string" },
                    tokenSymbol: { type: "string" },
                    totalSupply: { type: "string" },
                    deployerAddress: { type: "string" },
                    transactionHash: { type: "string" },
                    contractFeatures: {
                      type: "array",
                      items: { type: "string" },
                    },
                    gasUsed: { type: "integer" },
                    deploymentCost: { type: "string" },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
    "/api/fuse/loyalty/mint": {
      post: {
        summary: "Mint loyalty tokens to a recipient",
        description:
          "Mints additional loyalty tokens on an already-deployed Fuse " +
          "loyalty token contract. Used for customer rewards or business " +
          "payments.",
        "x-payment-info": paymentInfo("0.50"),
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
                    description: "Loyalty token contract address",
                    pattern: EVM_ADDRESS_PATTERN,
                  },
                  recipient: {
                    type: "string",
                    description: "Recipient wallet address",
                    pattern: EVM_ADDRESS_PATTERN,
                  },
                  amount: {
                    type: "number",
                    description: "Amount of tokens to mint (whole units)",
                    minimum: 0,
                  },
                  reason: {
                    type: "string",
                    description:
                      "Free-text reason for the mint (e.g. business_payment, " +
                      "referral_bonus)",
                  },
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
        responses: {
          "200": {
            description: "Tokens minted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    transactionHash: { type: "string" },
                    tokenAddress: { type: "string" },
                    recipient: { type: "string" },
                    amount: { type: "number" },
                    reason: { type: "string" },
                    gasUsed: { type: "integer" },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
    "/api/fuse/loyalty/balance/{token}/{address}": {
      get: {
        summary: "Check loyalty token balance",
        description:
          "Returns the balance of a specific Fuse loyalty/payment token held " +
          "by a given wallet address.",
        parameters: [
          {
            name: "token",
            in: "path",
            required: true,
            description: "Loyalty token contract address",
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
          {
            name: "address",
            in: "path",
            required: true,
            description: "Holder wallet address",
            schema: { type: "string", pattern: EVM_ADDRESS_PATTERN },
          },
        ],
        "x-payment-info": paymentInfo("0.02"),
        responses: {
          "200": {
            description: "Token balance",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tokenAddress: { type: "string" },
                    holderAddress: { type: "string" },
                    balance: { type: "string" },
                    lastUpdate: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "402": RESP_402,
        },
      },
    },
  },
};

// Per the x402scan well-known v1 spec, resources are "METHOD /path" strings,
// NOT full URLs or object entries. Dynamic routes keep Express :param syntax
// — x402scan normalizes these for catalog grouping.
const WELLKNOWN_X402 = {
  version: 1,
  resources: [
    "GET /api/fuse/stats",
    "GET /api/fuse/wallet/:address",
    "GET /api/fuse/defi/opportunities",
    "POST /api/fuse/loyalty/create",
    "POST /api/fuse/loyalty/mint",
    "GET /api/fuse/loyalty/balance/:token/:address",
  ],
};

module.exports = { OPENAPI_SPEC, WELLKNOWN_X402 };
