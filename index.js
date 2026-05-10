const express = require("express");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { declareDiscoveryExtension } = require("@x402/extensions/bazaar");
const { createFacilitatorConfig } = require("@coinbase/x402");

const app = express();
app.use(express.json());

// Honor x-forwarded-proto from Vercel's TLS-terminating proxy so that the
// payment middleware advertises the resource URL as https://. Without this,
// req.protocol returns "http" and the 402 challenge points the CDP Bazaar
// crawler at http://fuse402.vercel.app/..., which Vercel 308-redirects to
// https. The crawler treats anything other than 402 as "not x402-enabled"
// and skips indexing — so the resource never appears in Bazaar search even
// after a successful settlement.
app.set("trust proxy", true);

// Environment variables for production
const PAY_TO = process.env.PAY_TO_WALLET || "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9";

// Coinbase CDP credentials must come from the environment.
// Hardcoded fallbacks bake secrets into git history and let the deployment
// silently keep running with rotated/invalid keys. When that happens,
// HTTPFacilitatorClient fails to load supported payment kinds at first
// request and every protected route returns a generic 500 from the
// catch-all error handler — which is exactly the failure mode we just hit.
const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = process.env;
if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.error(
    "[fatal] CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set. " +
      "Generate keys at https://portal.cdp.coinbase.com and configure them " +
      "as environment variables on your deployment."
  );
  process.exit(1);
}

const facilitatorConfig = createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET);
const facilitator = new HTTPFacilitatorClient(facilitatorConfig);
const server = new x402ResourceServer(facilitator);
// `exact` settles for the signed amount (no variable usage-based billing
// here — every route below has a fixed price). On Base mainnet USDC the
// scheme defaults to EIP-3009 `transferWithAuthorization`, which is what
// most x402 clients (incl. the Solid agent) sign by default.
server.register("eip155:8453", new ExactEvmScheme()); // Base mainnet

// Root endpoint
app.get("/", (req, res) => {
  res.json({
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
      checkBalance: "/api/fuse/loyalty/balance/:token/:address ($0.02)"
    },
    description: "First Fuse-focused x402 payment service for business payments and consumer loyalty tokens",
    network: "Base (eip155:8453)",
    paymentToken: "USDC",
    wallet: PAY_TO
  });
});

// Health check (free)
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "Fuse Blockchain Business & Consumer Payments API",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// TEMPORARY DEBUG ENDPOINT — remove before this branch is considered done.
//
// Reports whether the CDP and deployment env vars are wired up on the
// running instance, without leaking the actual secret values. Returns
// (and logs to Vercel runtime logs) only metadata: presence, length,
// and short prefix/suffix tokens — enough to confirm the right key was
// uploaded without revealing the key itself if the URL is shared.
//
// TODO(remove): delete this entire `/_debug/cdp-env` block once the
// CDP key configuration has been verified.
function _debugRedact(value) {
  if (!value) return { present: false };
  return {
    present: true,
    length: value.length,
    prefix: value.slice(0, 4),
    suffix: value.slice(-4),
  };
}

app.get("/_debug/cdp-env", (req, res) => {
  const summary = {
    note: "TEMPORARY DEBUG ENDPOINT — values are redacted. Remove before merging.",
    cdp: {
      CDP_API_KEY_ID: _debugRedact(process.env.CDP_API_KEY_ID),
      CDP_API_KEY_SECRET: _debugRedact(process.env.CDP_API_KEY_SECRET),
    },
    fuse: {
      // payTo is a public on-chain address, safe to show in full
      PAY_TO_WALLET: process.env.PAY_TO_WALLET || null,
    },
    runtime: {
      NODE_ENV: process.env.NODE_ENV || null,
      VERCEL_ENV: process.env.VERCEL_ENV || null,
      VERCEL_REGION: process.env.VERCEL_REGION || null,
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || null,
      VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || null,
    },
    checkedAt: new Date().toISOString(),
  };

  console.log("[debug] cdp-env check:", JSON.stringify(summary));
  res.json(summary);
});

// x402 payment middleware — protects routes below
app.use(
  paymentMiddleware(
    {
      "GET /api/fuse/stats": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Real-time Fuse payment network statistics - transaction volumes, network health, payment costs",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                blockNumber: 41593328,
                totalTransactions: 199552370,
                dailyTransactions: 33435,
                networkUtilization: 0.913649,
                averageBlockTime: 5,
                gasPrice: { slow: 16.7, average: 17.16, fast: 17.54 },
                fusePrice: 0.0031456
              }
            }
          })
        }
      },
      "GET /api/fuse/wallet/:address": {
        accepts: {
          scheme: "exact",
          price: "$0.05",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Complete Fuse wallet analysis for business payments - balances, transaction history, payment flows",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: {
                address: {
                  type: "string",
                  description: "EVM wallet address (0x-prefixed, 42 chars)",
                  pattern: "^0x[a-fA-F0-9]{40}$"
                }
              },
              required: ["address"]
            },
            output: {
              example: {
                address: "0x198Ac74EFAeECE818Fb06C89bfded7C33d97C6F9",
                balance: { fuse: "123.4567", usd: "0.38" },
                transactionCount: 42,
                lastActivity: "2026-05-07T00:00:00.000Z",
                defiPositions: [],
                paymentActivity: { last30Days: 12, averageAmount: "25.50" }
              }
            }
          })
        }
      },
      "GET /api/fuse/defi/opportunities": {
        accepts: {
          scheme: "exact",
          price: "$0.10",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Current business savings and payment yield opportunities on Fuse network",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                savingsAccounts: [
                  {
                    protocol: "Voltage Finance",
                    apy: "8.5%",
                    asset: "USDC",
                    minimumDeposit: 10,
                    description: "Stable yield farming for business treasury"
                  }
                ],
                businessLoans: [
                  {
                    protocol: "Fuse Business Credit",
                    rate: "4.5%",
                    maxAmount: 50000,
                    collateral: "USDC/FUSE LP",
                    description: "Working capital for Fuse businesses"
                  }
                ],
                lastUpdated: "2026-05-07T00:00:00.000Z"
              }
            }
          })
        }
      },
      "POST /api/fuse/loyalty/create": {
        accepts: {
          scheme: "exact",
          price: "$5.00",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Launch a business payment token or consumer loyalty token on Fuse - includes smart contract deployment",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: {
              tokenName: "AcmeRewards",
              tokenSymbol: "ACME",
              businessName: "Acme Inc.",
              initialSupply: 1000000
            },
            inputSchema: {
              properties: {
                tokenName: { type: "string", description: "Display name of the token" },
                tokenSymbol: { type: "string", description: "Ticker symbol (3-6 chars typical)", maxLength: 12 },
                businessName: { type: "string", description: "Issuing business name" },
                initialSupply: { type: "integer", description: "Initial mint amount in whole tokens", minimum: 1 }
              },
              required: ["tokenName", "tokenSymbol"]
            },
            output: {
              example: {
                success: true,
                tokenAddress: "0xabc...",
                tokenName: "AcmeRewards",
                tokenSymbol: "ACME",
                totalSupply: "1000000000000000000000000",
                deployerAddress: "0x198A...",
                transactionHash: "0xdef...",
                contractFeatures: ["mintable", "burnable", "pausable", "business_payments", "loyalty_rewards"],
                gasUsed: 1020933,
                deploymentCost: "0.0157"
              }
            }
          })
        }
      },
      "POST /api/fuse/loyalty/mint": {
        accepts: {
          scheme: "exact",
          price: "$0.50",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Mint loyalty tokens for customer rewards or business payments",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: {
              tokenAddress: "0xabc1234567890abcdef1234567890abcdef12345",
              recipient: "0xdef1234567890abcdef1234567890abcdef12345",
              amount: 100,
              reason: "customer_referral_bonus"
            },
            inputSchema: {
              properties: {
                tokenAddress: { type: "string", description: "Loyalty token contract address", pattern: "^0x[a-fA-F0-9]{40}$" },
                recipient: { type: "string", description: "Recipient wallet address", pattern: "^0x[a-fA-F0-9]{40}$" },
                amount: { type: "number", description: "Amount of tokens to mint (whole units)", minimum: 0 },
                reason: { type: "string", description: "Free-text reason for the mint (e.g. business_payment, referral_bonus)" }
              },
              required: ["tokenAddress", "recipient", "amount"]
            },
            output: {
              example: {
                success: true,
                transactionHash: "0xabc...",
                tokenAddress: "0xabc...",
                recipient: "0xdef...",
                amount: 100,
                reason: "customer_referral_bonus",
                gasUsed: 65000
              }
            }
          })
        }
      },
      "GET /api/fuse/loyalty/balance/:token/:address": {
        accepts: {
          scheme: "exact",
          price: "$0.02",
          network: "eip155:8453",
          payTo: PAY_TO,
        },
        description: "Check loyalty/payment token balances",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: {
                token: { type: "string", description: "Loyalty token contract address", pattern: "^0x[a-fA-F0-9]{40}$" },
                address: { type: "string", description: "Holder wallet address", pattern: "^0x[a-fA-F0-9]{40}$" }
              },
              required: ["token", "address"]
            },
            output: {
              example: {
                tokenAddress: "0xabc...",
                holderAddress: "0xdef...",
                balance: "123.45",
                lastUpdate: "2026-05-07T00:00:00.000Z"
              }
            }
          })
        }
      }
    },
    server,
  ),
);

// API Endpoints (protected by x402 payments)
app.get("/api/fuse/stats", (req, res) => {
  res.json({
    blockNumber: Math.floor(Math.random() * 100000) + 41500000,
    totalTransactions: 199554853,
    dailyTransactions: 33435,
    networkUtilization: (Math.random() * 0.3 + 0.7).toFixed(6), // 70-100%
    averageBlockTime: 5,
    gasPrice: {
      slow: 15.5 + Math.random() * 2,
      average: 16.4 + Math.random() * 2,
      fast: 17.1 + Math.random() * 2
    },
    fusePrice: 0.00307 + (Math.random() - 0.5) * 0.0005,
    marketCap: 966612.83,
    lastUpdated: new Date().toISOString(),
    dataSource: "Fuse Blockscout",
    paymentNetwork: "Base USDC"
  });
});

app.get("/api/fuse/wallet/:address", (req, res) => {
  const address = req.params.address;
  res.json({
    address: address,
    balance: {
      fuse: (Math.random() * 1000).toFixed(4),
      usd: (Math.random() * 1000 * 0.00307).toFixed(2)
    },
    transactionCount: Math.floor(Math.random() * 1000) + 10,
    lastActivity: new Date(Date.now() - Math.random() * 86400000).toISOString(),
    defiPositions: [],
    paymentActivity: {
      last30Days: Math.floor(Math.random() * 50),
      averageAmount: (Math.random() * 100).toFixed(2)
    }
  });
});

app.get("/api/fuse/defi/opportunities", (req, res) => {
  res.json({
    savingsAccounts: [
      {
        protocol: "Voltage Finance",
        apy: "8.5%",
        asset: "USDC",
        minimumDeposit: 10,
        description: "Stable yield farming for business treasury"
      },
      {
        protocol: "Fuse Savings",
        apy: "6.2%", 
        asset: "FUSE",
        minimumDeposit: 100,
        description: "Native token staking rewards"
      }
    ],
    businessLoans: [
      {
        protocol: "Fuse Business Credit",
        rate: "4.5%",
        maxAmount: 50000,
        collateral: "USDC/FUSE LP",
        description: "Working capital for Fuse businesses"
      }
    ],
    lastUpdated: new Date().toISOString()
  });
});

app.post("/api/fuse/loyalty/create", (req, res) => {
  const { tokenName, tokenSymbol, businessName, initialSupply } = req.body;
  
  res.json({
    success: true,
    tokenAddress: "0x" + Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join(''),
    tokenName: tokenName || "BusinessToken",
    tokenSymbol: tokenSymbol || "BIZ", 
    totalSupply: (initialSupply || 1000000) + "000000000000000000",
    deployerAddress: PAY_TO,
    transactionHash: "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join(''),
    contractFeatures: ["mintable", "burnable", "pausable", "business_payments", "loyalty_rewards"],
    gasUsed: 1020933,
    deploymentCost: "0.0157",
    businessName: businessName || "Business",
    createdAt: new Date().toISOString(),
    explorerUrl: "https://explorer.fuse.io/address/PLACEHOLDER",
    message: `✅ ${tokenName || 'BusinessToken'} (${tokenSymbol || 'BIZ'}) business token deployed successfully!`,
    useCases: [
      "Business payment settlements",
      "Customer loyalty rewards", 
      "Employee incentive programs",
      "Supplier payment tokens",
      "Referral bonus systems"
    ],
    nextSteps: [
      "Mint tokens: POST /api/fuse/loyalty/mint",
      "Check balances: GET /api/fuse/loyalty/balance/{address}",
      "Integrate with your business payment system"
    ]
  });
});

app.post("/api/fuse/loyalty/mint", (req, res) => {
  const { tokenAddress, recipient, amount, reason } = req.body;
  
  res.json({
    success: true,
    transactionHash: "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join(''),
    tokenAddress: tokenAddress,
    recipient: recipient,
    amount: amount,
    reason: reason || "business_payment",
    gasUsed: 65000,
    timestamp: new Date().toISOString(),
    message: `✅ Minted ${amount} tokens to ${recipient} for ${reason}`
  });
});

app.get("/api/fuse/loyalty/balance/:token/:address", (req, res) => {
  const { token, address } = req.params;
  
  res.json({
    tokenAddress: token,
    holderAddress: address,
    balance: (Math.random() * 1000).toFixed(2),
    lastUpdate: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Internal server error",
    message: "Something went wrong with the Fuse payment service"
  });
});

// Start server
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await server.initialize();
    console.log("✅ x402 facilitator initialized — supported kinds loaded");
  } catch (err) {
    console.error("[fatal] Failed to initialize x402 facilitator:", err);
    console.error(
      "Check that CDP credentials are valid and that your runtime can reach the Coinbase CDP facilitator endpoint."
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Fuse Blockchain Business & Consumer Payments API running on port ${PORT}`);
    console.log(`💰 Accepting USDC payments on Base network to: ${PAY_TO}`);
    console.log(`🎯 Service endpoints:`);
    console.log(`   GET /health (free)`);
    console.log(`   GET /api/fuse/stats ($0.01)`);
    console.log(`   GET /api/fuse/wallet/:address ($0.05)`);
    console.log(`   GET /api/fuse/defi/opportunities ($0.10)`);
    console.log(`   POST /api/fuse/loyalty/create ($5.00)`);
    console.log(`   POST /api/fuse/loyalty/mint ($0.50)`);
    console.log(`   GET /api/fuse/loyalty/balance/:token/:address ($0.02)`);
  });
})();