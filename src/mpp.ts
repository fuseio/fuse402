// MPP (Machine Payments Protocol) setup. Creates a single Mppx instance with
// three payment methods — Tempo USDC, Stripe (Visa/Mastercard/wallets), and
// Bitcoin Lightning via Spark — and exposes helpers the dual-pay middleware
// uses to verify credentials and emit WWW-Authenticate challenges.
//
// We use `mppx/server`'s core Mppx rather than `mppx/express`'s wrapper
// because the wrapper drops `compose()` — the only way to issue a single
// 402 advertising multiple methods. The Express adapter lives in
// src/middleware/dual-pay.ts.

import { spark } from "@buildonspark/lightning-mpp-sdk/server";
import { Mppx, stripe, tempo } from "mppx/server";
import Stripe from "stripe";

import {
  BTC_MNEMONIC,
  BTC_NETWORK,
  BTC_USD_RATE,
  LIGHTNING_CURRENCY,
  MPP_REALM,
  MPP_SECRET_KEY,
  SAT_PER_BTC,
  STRIPE_NETWORK_ID,
  STRIPE_PAYMENT_METHOD_TYPES,
  STRIPE_SECRET_KEY,
  TEMPO_CURRENCY,
  TEMPO_PAY_TO,
  TEMPO_TESTNET,
  USD_DECIMALS,
  USDC_DECIMALS,
} from "./config.js";

// Lazy-init so that disabling MPP (MPP_ENABLED=false in config.ts) doesn't
// trip the Stripe constructor at module-load time with a stub-empty key.
// Once `getMpp()` is called the result is cached for the rest of the
// process — the underlying Stripe client and Mppx instance are stateless
// enough to be reused across requests.
let _mpp: ReturnType<typeof buildMpp> | undefined;

function buildMpp() {
  const stripeClient = new Stripe(STRIPE_SECRET_KEY);
  return Mppx.create({
    realm: MPP_REALM,
    secretKey: MPP_SECRET_KEY,
    methods: [
      tempo.charge({
        currency: TEMPO_CURRENCY,
        recipient: TEMPO_PAY_TO,
        decimals: USDC_DECIMALS,
        testnet: TEMPO_TESTNET,
      }),
      stripe.charge({
        client: stripeClient,
        networkId: STRIPE_NETWORK_ID,
        currency: "usd",
        decimals: USD_DECIMALS,
        paymentMethodTypes: [...STRIPE_PAYMENT_METHOD_TYPES],
      }),
      spark.charge({
        mnemonic: BTC_MNEMONIC,
        network: BTC_NETWORK,
      }),
    ],
  });
}

export function getMpp() {
  if (!_mpp) _mpp = buildMpp();
  return _mpp;
}

export function dollarsToSats(usd: string): string {
  const sats = Math.max(1, Math.round((Number(usd) * SAT_PER_BTC) / BTC_USD_RATE));
  return String(sats);
}

// Per-route composition entries the dual-pay middleware passes to
// mpp.compose() and mpp.challenge.*. Tempo + Stripe use the same dollar
// string; lightning needs a sat-denominated amount.
export function composeEntriesForUsd(usd: string, description: string) {
  const sats = dollarsToSats(usd);
  return {
    tempo: { amount: usd, description },
    stripe: { amount: usd, description },
    lightning: { amount: sats, currency: LIGHTNING_CURRENCY, description },
  } as const;
}
