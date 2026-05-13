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

// Base mainnet (chain 8453) is where USDC payments settle via x402.
// Loyalty tokens live on Fuse mainnet (chain 122); the Fuse chain config
// is imported from viem/chains in src/clients/viem.ts rather than tracked
// here.
export const BASE_NETWORK_TAG = "eip155:8453";

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
  "Fuse402 — Fuse Network Business Payments & Loyalty API";
export const LANDING_DESCRIPTION =
  "Pay-per-request access to Fuse Network blockchain data and business " +
  "payment infrastructure. Settles in USDC on Base via x402.";
