// Centralized env validation. Every required secret is read here so the
// server fails loudly at boot rather than the first request that needs it.
// Hardcoded fallbacks were deliberately removed: a baked-in fallback lets
// the deployment silently keep running with rotated/invalid keys and
// surface as generic 500s on protected routes.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `[fatal] ${name} must be set. See .env.example for how to obtain it.`,
    );
    process.exit(1);
  }
  return v;
}

export const PAY_TO = required("PAY_TO_WALLET");
export const CDP_API_KEY_ID = required("CDP_API_KEY_ID");
export const CDP_API_KEY_SECRET = required("CDP_API_KEY_SECRET");
export const DEPLOYER_PRIVATE_KEY = required("DEPLOYER_PRIVATE_KEY");

export const PORT = Number(process.env.PORT) || 3000;

export const HOST_URL = process.env.HOST_URL || "https://ai.fuse.io";

// `realm` field on MPP challenges + the HMAC binding input. Pinning it to
// the canonical public hostname keeps pre-built challenges and runtime
// dispatch in agreement; otherwise mpp's auto-detect falls back to the
// captured request URL (or the literal string "MPP Payment") and the
// HMAC verification rejects credentials cross-issued between the two paths.
export const MPP_REALM = new URL(HOST_URL).hostname;

// Base mainnet (chain 8453) is where USDC payments settle via x402.
// Loyalty tokens live on Fuse mainnet (chain 122); the Fuse chain config
// is imported from viem/chains in src/clients/viem.ts rather than tracked
// here.
export const BASE_NETWORK_TAG = "eip155:8453";

// MPP (Machine Payments Protocol) configuration. When MPP_ENABLED is true,
// the dual-pay middleware verifies MPP credentials and emits MPP
// `WWW-Authenticate: Payment` challenges alongside x402's `X-PAYMENT-REQUIRED`
// header on 402 responses. All MPP_* env vars are only required when the
// flag is on so a partial rollout (code shipped, methods disabled) is safe.
export const MPP_ENABLED =
  (process.env.MPP_ENABLED ?? "true").toLowerCase() === "true";

export const MPP_SECRET_KEY = MPP_ENABLED ? required("MPP_SECRET_KEY") : "";

// Tempo: native MPP stablecoin network. TEMPO_TESTNET=true uses the Tempo
// testnet (no real funds). The default TEMPO_CURRENCY is pathUSD per the
// MPP docs; override per-chain by setting it in env. Addresses are narrowed
// to viem's `0x${string}` template type because the MPP tempo.charge config
// rejects plain string.
function evmAddress(name: string, raw: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    console.error(`[fatal] ${name} must be a 0x-prefixed 40-hex-char EVM address (got "${raw}").`);
    process.exit(1);
  }
  return raw as `0x${string}`;
}
export const TEMPO_PAY_TO: `0x${string}` = MPP_ENABLED
  ? evmAddress("TEMPO_PAY_TO", required("TEMPO_PAY_TO"))
  : "0x0000000000000000000000000000000000000000";

export const TEMPO_TESTNET =
  (process.env.TEMPO_TESTNET ?? "true").toLowerCase() === "true";

// Tempo's default stablecoin per network — mirrors mppx's internal
// defaults. Exported so flipping TEMPO_TESTNET also flips the token
// without a second env-var edit. Override by setting TEMPO_CURRENCY.
const TEMPO_USDC_MAINNET = "0x20C000000000000000000000b9537d11c60E8b50" as const;
const TEMPO_PATHUSD_TESTNET = "0x20c0000000000000000000000000000000000000" as const;
export const TEMPO_CURRENCY: `0x${string}` = process.env.TEMPO_CURRENCY
  ? evmAddress("TEMPO_CURRENCY", process.env.TEMPO_CURRENCY)
  : TEMPO_TESTNET
    ? TEMPO_PATHUSD_TESTNET
    : TEMPO_USDC_MAINNET;

// Stripe: fiat rail (Visa, Mastercard, wallets) via Shared Payment Tokens.
// Requires a Stripe account with machine payments enabled; networkId is the
// Business Network profile ID from the Stripe Dashboard.
export const STRIPE_SECRET_KEY = MPP_ENABLED
  ? required("STRIPE_SECRET_KEY")
  : "";
export const STRIPE_NETWORK_ID = MPP_ENABLED
  ? required("STRIPE_NETWORK_ID")
  : "";

// Lightning via Spark. BTC_NETWORK selects regtest/signet/mainnet; mnemonic
// seeds the server-side Spark wallet that receives payments.
export const BTC_MNEMONIC = MPP_ENABLED ? required("BTC_MNEMONIC") : "";
const BTC_NETWORK_RAW = (process.env.BTC_NETWORK ?? "regtest").toLowerCase();
if (!["regtest", "signet", "mainnet"].includes(BTC_NETWORK_RAW)) {
  console.error(
    `[fatal] BTC_NETWORK must be one of regtest|signet|mainnet (got "${BTC_NETWORK_RAW}").`,
  );
  process.exit(1);
}
export const BTC_NETWORK = BTC_NETWORK_RAW as "regtest" | "signet" | "mainnet";

// Bitcoin denomination constants. SAT_PER_BTC is fixed forever (Bitcoin
// consensus). BTC_USD_RATE is approximate FX used to convert per-route USD
// prices to sat-denominated MPP challenges for Lightning — see src/mpp.ts.
// MPP challenges expire (default 5 min) so a stale rate just nudges the
// quoted sat amount; the BOLT11 invoice itself is what the client pays.
export const SAT_PER_BTC = 100_000_000;
export const BTC_USD_RATE = Number(process.env.BTC_USD_RATE) || 100_000;

// Stablecoin decimal precision used in MPP method configs:
//   - USDC on Tempo and most EVM chains: 6 decimals
//   - USD as a Stripe currency: 2 decimals (cents)
export const USDC_DECIMALS = 6;
export const USD_DECIMALS = 2;

// Stripe payment method types accepted on MPP charges. Cards covers Visa,
// Mastercard, Amex, etc. Add 'link' or 'us_bank_account' here if/when
// machine payments unlocks them.
export const STRIPE_PAYMENT_METHOD_TYPES = ["card"] as const;

// Lightning currency unit used in MPP charge offers. BOLT11 invoices
// natively denominate in satoshis, so we always quote sats on the wire.
export const LIGHTNING_CURRENCY = "sat";

// External APIs used by route handlers. Kept here so URL changes ripple
// through a single file rather than the request layer.
export const FUSE_BLOCKSCOUT_URL = "https://explorer.fuse.io";
export const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
export const DEFILLAMA_CHAINS_URL = "https://api.llama.fi/v2/chains";
export const SOLID_ANALYTICS_URL = "https://analytics.solid.xyz";

// Canonical sFuse brand asset hosted on the Fuse Network Webflow CDN.
// Used as the openapi info.x-logo and as the /favicon.* redirect target.
export const SFUSE_ICON_URL =
  "https://cdn.prod.website-files.com/63a6d0820bd1f472b4150067/65b77eabcf2a293d3401c01f_sFuse.png";

// Public landing-page copy used by the HTML renderer and OpenAPI info.
export const LANDING_TITLE =
  "Fuse AI — Fuse Network Business Payments & Loyalty API";
export const LANDING_DESCRIPTION =
  "Pay-per-request access to Fuse Network blockchain data and business " +
  "payment infrastructure. Accepts USDC (Base via x402; Tempo via MPP), " +
  "Visa/Mastercard/wallets (Stripe via MPP), and Bitcoin Lightning (MPP).";
