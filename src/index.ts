// Patches run before anything else imports @x402/core/server so the
// prototype wrap and fetch wrap are in place by the time the first
// request lands. cdp-debug-logger goes first; extensions-forward wraps
// AROUND it (cdp logger sees the post-mutation body). keychain-error
// translation wraps both — it only inspects RESPONSES from Tempo RPC,
// so wrap-order is irrelevant for correctness but applying it last
// keeps the diff trivially auditable.
import { applyCdpDebugLogger } from "./patches/cdp-debug-logger.js";
import { applyExtensionsForwardPatch } from "./patches/extensions-forward.js";
import { applyKeychainErrorTranslationPatch } from "./patches/keychain-error-translation.js";

applyCdpDebugLogger();
applyExtensionsForwardPatch();
applyKeychainErrorTranslationPatch();

import { createFacilitatorConfig } from "@coinbase/x402";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  BASE_NETWORK_TAG,
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  HOST_URL,
  MPP_ENABLED,
  PAY_TO,
  PORT,
  SFUSE_ICON_URL,
} from "./config.js";
import { OPENAPI_SPEC, WELLKNOWN_X402 } from "./discovery.js";
import { renderLandingHtml } from "./landing.js";
import {
  dualPay,
  matchRoute,
  type PaidRoute,
  x402SkipIfMppPaid,
} from "./middleware/dual-pay.js";
import { defiOpportunitiesHandler } from "./routes/defi.js";
import {
  loyaltyBalanceHandler,
  loyaltyCreateHandler,
  loyaltyMintHandler,
} from "./routes/loyalty.js";
import { statsHandler } from "./routes/stats.js";
import { walletHandler } from "./routes/wallet.js";

// Single source of truth for the route → price/description map shared by
// the MPP preflight, the OpenAPI discovery doc, and x402's routesMap below.
// Edit prices or paths here and verify the three sites stay aligned.
const PAID_ROUTES: PaidRoute[] = [
  { method: "GET", pattern: "/api/fuse/stats", usd: "0.01", description: "Real-time Fuse network statistics" },
  { method: "GET", pattern: "/api/fuse/wallet/:address", usd: "0.05", description: "Fuse wallet analysis" },
  { method: "GET", pattern: "/api/fuse/defi/opportunities", usd: "0.10", description: "Fuse DeFi yield opportunities" },
  { method: "POST", pattern: "/api/fuse/loyalty/create", usd: "5.00", description: "Deploy LoyaltyToken ERC-20 on Fuse" },
  { method: "POST", pattern: "/api/fuse/loyalty/mint", usd: "0.50", description: "Mint loyalty tokens" },
  { method: "GET", pattern: "/api/fuse/loyalty/balance/:token/:address", usd: "0.02", description: "Read ERC-20 balance on Fuse" },
];

const app = express();
app.use(express.json());

// Honor x-forwarded-proto from Vercel's TLS-terminating proxy so the
// payment middleware advertises the resource URL as https://. Without
// this, req.protocol is "http" and the 402 challenge points crawlers at
// http://... which Vercel 308-redirects. Crawlers treat anything other
// than 402 as "not x402-enabled" and skip indexing.
app.set("trust proxy", true);

// Workaround for an upstream bug in @x402/core's route matcher that
// breaks Bazaar indexing for any service registering its routes as
// "GET ...". CDP's crawler fans HEAD probes across the resource path;
// the matcher does strict method equality (GET !== HEAD), requiresPayment
// returns false, Express routes the HEAD to the GET handler with body
// stripped, and returns 200 OK instead of 402 — disqualifying the
// resource from indexing. Per RFC 7231 §4.3.2, HEAD is GET without a
// body, so rewriting req.method here is spec-compliant.
//
// TODO(remove): drop once @x402/core fixes getRouteConfig.
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.method === "HEAD") req.method = "GET";
  next();
});

const facilitatorConfig = createFacilitatorConfig(
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
);
const facilitator = new HTTPFacilitatorClient(facilitatorConfig);
const server = new x402ResourceServer(facilitator);
// `exact` settles for the signed amount (every route below has a fixed
// price). On Base mainnet USDC the scheme defaults to EIP-3009
// `transferWithAuthorization`, which is what x402 clients sign by default.
server.register(BASE_NETWORK_TAG, new ExactEvmScheme());

// Root — JSON when explicitly requested, HTML by default (so crawlers
// and browsers see meta tags for x402scan to read).
app.get("/", (_req: Request, res: Response) => {
  const apiInfo = {
    service: "Fuse Blockchain Business & Consumer Payments API",
    status: "live",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      stats: "/api/fuse/stats ($0.01)",
      wallet: "/api/fuse/wallet/:address ($0.05)",
      opportunities: "/api/fuse/defi/opportunities ($0.10)",
      createToken: "POST /api/fuse/loyalty/create ($5.00)",
      mintRewards: "POST /api/fuse/loyalty/mint ($0.50)",
      checkBalance: "/api/fuse/loyalty/balance/:token/:address ($0.02)",
    },
    network: BASE_NETWORK_TAG,
    paymentToken: "USDC",
    wallet: PAY_TO,
    host: HOST_URL,
  };
  res.format({
    "application/json": () => res.json(apiInfo),
    "text/html": () => res.type("html").send(renderLandingHtml()),
    default: () => res.type("html").send(renderLandingHtml()),
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "Fuse Blockchain Business & Consumer Payments API",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Discovery endpoints (free). Defined BEFORE paymentMiddleware so they
// short-circuit to our handlers and never get inspected for payment.
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(OPENAPI_SPEC);
});
app.get("/.well-known/x402", (_req: Request, res: Response) => {
  res.json(WELLKNOWN_X402);
});

// Favicon — crawlers and x402scan probe /favicon.ico for the origin's
// icon. Redirect both .ico and .png to the canonical sFuse asset.
app.get(["/favicon.ico", "/favicon.png"], (_req: Request, res: Response) => {
  res.redirect(302, SFUSE_ICON_URL);
});

// MPP preflight — runs before x402. For each request that matches a paid
// route, it either: (a) verifies an `Authorization: Payment …` credential
// and marks req.__mppPaid so x402 skips, (b) lets x402 take over for
// `X-PAYMENT` clients, or (c) pre-builds MPP `WWW-Authenticate: Payment`
// challenges and hooks res.writeHead so x402's 402 response also carries
// them. Toggle via MPP_ENABLED env var.
if (MPP_ENABLED) {
  app.use(async (req, res, next) => {
    const route = matchRoute(req, PAID_ROUTES);
    if (!route) return next();
    return dualPay(route.usd, route.description)(req, res, next);
  });
}

// x402 payment middleware — protects everything below.
app.use(
  x402SkipIfMppPaid(
  paymentMiddleware(
    {
      "GET /api/fuse/stats": {
        accepts: [
          { scheme: "exact", price: "$0.01", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description:
          "Real-time Fuse payment network statistics — transaction " +
          "volumes, network health, gas tiers, FUSE token price.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                blockNumber: 41935489,
                totalTransactions: 200195759,
                dailyTransactions: 21479,
                networkUtilization: 0.7188013,
                averageBlockTime: 5,
                gasPrice: { slow: 17.89, average: 18.62, fast: 19.12 },
                fusePrice: 0.00317466,
                marketCap: 998052.68,
              },
            },
          }),
        },
      },
      "GET /api/fuse/wallet/:address": {
        accepts: [
          { scheme: "exact", price: "$0.05", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description:
          "Complete Fuse wallet analysis — balances, transaction history, " +
          "payment flows.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: {
                address: {
                  type: "string",
                  description: "EVM wallet address (0x-prefixed, 42 chars)",
                  pattern: "^0x[a-fA-F0-9]{40}$",
                },
              },
              required: ["address"],
            },
            output: {
              example: {
                address: "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
                balance: {
                  fuse: "1234.56",
                  fuseWei: "1234560000000000000000",
                  usd: 3.92,
                },
                transactionCount: 482,
                tokenTransferCount: 47,
                lastActivityAt: "2026-05-13T18:42:11.000Z",
                thirtyDayActivity: {
                  transactions: 36,
                  uniqueCounterparties: 12,
                  inflowFuse: "210.00",
                  outflowFuse: "175.50",
                },
                explorerUrl:
                  "https://explorer.fuse.io/address/0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
              },
            },
          }),
        },
      },
      "GET /api/fuse/defi/opportunities": {
        accepts: [
          { scheme: "exact", price: "$0.10", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description:
          "Live Fuse DeFi yield opportunities — TVL from DefiLlama plus " +
          "APY from Solid.xyz.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                chain: { name: "Fuse", tvlUsd: 283933.01, nativeToken: "FUSE" },
                protocols: {
                  Yield: [
                    {
                      name: "Solid Yield",
                      slug: "solid-yield",
                      url: "https://solid.xyz",
                      tvlUsd: 369547,
                      description:
                        "SoUSD yield auto-compounded across trusted DeFi protocols",
                    },
                  ],
                  Dexs: [
                    {
                      name: "Voltage V4",
                      slug: "voltage-v4",
                      url: "https://app.voltage.finance/",
                      tvlUsd: 175151,
                      description: null,
                    },
                  ],
                },
                solidYield: {
                  usdc: {
                    currentApy: 6.92,
                    windows: {
                      allTime: 7.67,
                      sevenDay: 5.4,
                      fifteenDay: 6.92,
                      thirtyDay: 5.71,
                    },
                    description:
                      "SoUSD yield — auto-compounded across trusted DeFi protocols",
                  },
                  fuse: {
                    currentApy: 6.92,
                    windows: {
                      allTime: 14.81,
                      sevenDay: 8.2,
                      fifteenDay: 12.6,
                      thirtyDay: 10.15,
                    },
                    description: "SoFUSE yield — native-token staking returns",
                  },
                },
                lastUpdated: "2026-05-13T12:00:00.000Z",
                dataSources: ["DefiLlama", "Solid.xyz analytics"],
              },
            },
          }),
        },
      },
      "POST /api/fuse/loyalty/create": {
        accepts: [
          { scheme: "exact", price: "$5.00", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description:
          "Deploy a real LoyaltyToken ERC-20 (mintable, burnable, ownable, " +
          "minter-acl) on Fuse mainnet. Caller is the on-chain owner.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: {
              tokenName: "AcmeRewards",
              tokenSymbol: "ACME",
              owner: "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
              businessName: "Acme Inc.",
              initialSupply: 1000000,
            },
            inputSchema: {
              properties: {
                tokenName: { type: "string", maxLength: 64 },
                tokenSymbol: { type: "string", maxLength: 12 },
                owner: {
                  type: "string",
                  description:
                    "Caller's wallet address — becomes the on-chain owner.",
                  pattern: "^0x[a-fA-F0-9]{40}$",
                },
                businessName: { type: "string", maxLength: 120 },
                initialSupply: { type: "integer", minimum: 0 },
              },
              required: ["tokenName", "tokenSymbol", "owner"],
            },
            output: {
              example: {
                success: true,
                tokenAddress: "0xabc1234567890abcdef1234567890abcdef12345",
                transactionHash: "0xdeadbeef000000000000000000000000000000000000000000000000cafebabe",
                tokenName: "AcmeRewards",
                tokenSymbol: "ACME",
                owner: "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
                businessName: "Acme Inc.",
                initialSupply: 1000000,
                decimals: 18,
                deployerMinter: true,
                blockNumber: 41935489,
                gasUsed: 1850000,
                explorerUrl: "https://explorer.fuse.io/tx/0xdeadbeef...",
              },
            },
          }),
        },
      },
      "POST /api/fuse/loyalty/mint": {
        accepts: [
          { scheme: "exact", price: "$0.50", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description:
          "Mint loyalty tokens for customer rewards or business payments. " +
          "Requires the service deployer to still hold the minter role for " +
          "the target token (revocable by owner via setMinter).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: {
              tokenAddress: "0xabc1234567890abcdef1234567890abcdef12345",
              recipient: "0xdef1234567890abcdef1234567890abcdef12345",
              amount: 100,
              reason: "customer_referral_bonus",
            },
            inputSchema: {
              properties: {
                tokenAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
                recipient: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
                amount: { type: "number", minimum: 0 },
                reason: { type: "string" },
              },
              required: ["tokenAddress", "recipient", "amount"],
            },
            output: {
              example: {
                success: true,
                transactionHash: "0xabc...",
                tokenAddress: "0xabc1234567890abcdef1234567890abcdef12345",
                recipient: "0xdef1234567890abcdef1234567890abcdef12345",
                amount: 100,
                amountWei: "100000000000000000000",
                decimals: 18,
                reason: "customer_referral_bonus",
                blockNumber: 41935489,
                gasUsed: 65000,
                explorerUrl: "https://explorer.fuse.io/tx/0xabc...",
              },
            },
          }),
        },
      },
      "GET /api/fuse/loyalty/balance/:token/:address": {
        accepts: [
          { scheme: "exact", price: "$0.02", network: BASE_NETWORK_TAG, payTo: PAY_TO },
        ],
        description: "Read any Fuse ERC-20 token balance via viem.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: {
                token: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
                address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
              },
              required: ["token", "address"],
            },
            output: {
              example: {
                token: "0xabc1234567890abcdef1234567890abcdef12345",
                address: "0xdef1234567890abcdef1234567890abcdef12345",
                symbol: "ACME",
                decimals: 18,
                balance: "100.000000000000000000",
                balanceWei: "100000000000000000000",
              },
            },
          }),
        },
      },
    },
    server,
  ),
  ),
);

// Protected route handlers — real implementations live in src/routes.
app.get("/api/fuse/stats", statsHandler);
app.get("/api/fuse/wallet/:address", walletHandler);
app.get("/api/fuse/defi/opportunities", defiOpportunitiesHandler);
app.post("/api/fuse/loyalty/create", loyaltyCreateHandler);
app.post("/api/fuse/loyalty/mint", loyaltyMintHandler);
app.get("/api/fuse/loyalty/balance/:token/:address", loyaltyBalanceHandler);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error((err as Error).stack ?? err);
  res.status(500).json({
    error: "internal_server_error",
    message: "Something went wrong with the Fuse payment service",
  });
});

(async () => {
  try {
    await server.initialize();
    console.log("✅ x402 facilitator initialized — supported kinds loaded");
  } catch (err) {
    console.error("[fatal] Failed to initialize x402 facilitator:", err);
    console.error(
      "Check that CDP credentials are valid and that your runtime can reach the Coinbase CDP facilitator endpoint.",
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Fuse Blockchain Business & Consumer Payments API on :${PORT}`);
    console.log(`💰 Accepting USDC payments on Base network to: ${PAY_TO}`);
    if (MPP_ENABLED) {
      console.log("💳 Accepting MPP: tempo / stripe / lightning");
    }
  });
})();
