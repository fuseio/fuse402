// HTML landing page served at GET /. x402scan reads:
//   <title>                          → origin.title
//   <meta name="description">        → origin.description
//   <meta property="og:image">       → ogImages[]
// Other crawlers/browsers see the same content for OpenGraph/Twitter cards.

import {
  HOST_URL,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  PAY_TO,
  SFUSE_ICON_URL,
} from "./config.js";

// Minimal HTML escape for any future dynamic values inserted into the
// template. The current constants don't need it, but keeping the helper
// here means we don't regress if someone later substitutes user-supplied
// or env-supplied data into the template.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderLandingHtml(): string {
  const t = escapeHtml(LANDING_TITLE);
  const d = escapeHtml(LANDING_DESCRIPTION);
  const img = escapeHtml(SFUSE_ICON_URL);
  const url = escapeHtml(HOST_URL);
  const wallet = escapeHtml(PAY_TO);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<link rel="icon" href="/favicon.ico">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5rem; }
  .desc { color: #555; margin-top: 0; }
  ul { padding-left: 1.5rem; }
  li { margin: 0.4rem 0; }
  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
  .footer { margin-top: 2rem; color: #777; font-size: 0.85em; border-top: 1px solid #eee; padding-top: 1rem; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>${t}</h1>
<p class="desc">${d}</p>
<h2>Paid endpoints</h2>
<ul>
<li><code>GET /api/fuse/stats</code> — Real-time Fuse network statistics ($0.01)</li>
<li><code>GET /api/fuse/wallet/:address</code> — Wallet balance, tx count, token transfers, 30-day activity ($0.05)</li>
<li><code>GET /api/fuse/defi/opportunities</code> — Business DeFi yield opportunities ($0.10)</li>
<li><code>POST /api/fuse/loyalty/create</code> — Deploy a loyalty/payment token ($5.00)</li>
<li><code>POST /api/fuse/loyalty/mint</code> — Mint loyalty tokens to a recipient ($0.50)</li>
<li><code>GET /api/fuse/loyalty/balance/:token/:address</code> — Check ERC-20 token balance ($0.02)</li>
</ul>
<h2>Discovery</h2>
<ul>
<li><a href="/openapi.json">OpenAPI 3.1.0 specification</a></li>
<li><a href="/.well-known/x402">x402 well-known v1</a></li>
</ul>
<p class="footer">
Settles in USDC on Base mainnet (eip155:8453) via the x402 protocol. No accounts, no API keys.<br>
Merchant: <code>${wallet}</code>
</p>
</body>
</html>`;
}
