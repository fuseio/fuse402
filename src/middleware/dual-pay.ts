// Dual-protocol payment middleware. Wires MPP (Tempo / Stripe / Lightning)
// onto routes that already go through x402's app-level paymentMiddleware so
// the same endpoint can be paid via either protocol on the same wire.
//
// Per-request dispatch:
//   1. `Authorization: Payment …` header → verify via mpp.compose() and mark
//      req as MPP-paid so the x402 skip-guard lets it through.
//   2. `X-PAYMENT` header → fall through; existing x402 paymentMiddleware
//      verifies and emits its own responses.
//   3. No payment header → pre-generate one Challenge per MPP method and
//      attach them via `res.setHeader("WWW-Authenticate", [...])` before
//      handing off to x402. Node serializes WWW-Authenticate array values
//      as one header line per entry, so x402's 402 carries both x402's
//      X-PAYMENT-REQUIRED and one WWW-Authenticate per MPP method. MPP
//      clients reading WWW-Authenticate get real challenges; x402 clients
//      reading X-PAYMENT-REQUIRED keep working unchanged.

import { Challenge } from "mppx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { composeEntriesForUsd, getMpp } from "../mpp.js";

// Per-request state. We tag req/res with these via intersection rather than
// module augmentation so the types stay local to this file (no global
// pollution; module-augment lookup is fragile under Express 5's type setup).
type ReqWithState = Request & { __mppPaid?: boolean };
type ResWithState = Response & {
  __mppReceiptHeader?: string;
};

export type PaidRoute = {
  method: "GET" | "POST";
  pattern: string;
  usd: string;
  description: string;
};

// Match an incoming request against a route pattern using simple segment
// matching with `:param` wildcards. Sufficient for our six route shapes —
// avoids pulling in path-to-regexp at runtime.
export function matchRoute(req: Request, routes: PaidRoute[]): PaidRoute | null {
  const segs = req.path.split("/");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const ps = r.pattern.split("/");
    if (ps.length !== segs.length) continue;
    if (ps.every((seg, i) => seg.startsWith(":") || seg === segs[i])) return r;
  }
  return null;
}

// Convert an Express request into a Web Request that mpp.compose() can
// consume. Body forwarding is omitted to mirror the upstream `payment()`
// helper — POST endpoints lose body digest binding but verification still
// works against the per-method credential.
//
// We flatten the IncomingHttpHeaders shape (`string | string[] | undefined`)
// into Headers explicitly — the previous `as Record<string, string>` cast
// lied to the typechecker and would join multi-value headers (e.g. Cookie)
// with commas, which corrupts MPP's `Authorization` extraction in rare
// proxy-rewrite cases.
function reqToWebRequest(req: Request): globalThis.Request {
  const headers = new globalThis.Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  return new globalThis.Request(
    `${req.protocol}://${req.hostname}${req.originalUrl}`,
    { method: req.method, headers },
  );
}

// Build per-method challenges for the no-credential WWW-Authenticate
// emission. Lightning is deliberately excluded here: Spark's `request()`
// hook mints a fresh BOLT11 invoice on every challenge generation by
// calling out to the Spark service, which would burn ~N invoices on every
// crawler hit. Lightning still surfaces to clients via the OpenAPI
// `x-payment-info.offers[]` and is verified at `Authorization: Payment`
// time when the client actually pays.
//
// Uses Promise.allSettled so one method's failure doesn't take down the
// whole batch — e.g. if Tempo's RPC is flaky on a particular invocation,
// Stripe still emits. Rejected entries are logged so the cause surfaces
// in Vercel logs.
async function buildChallengeHeaders(usd: string, description: string): Promise<string[]> {
  const entries = composeEntriesForUsd(usd, description);
  const mpp = getMpp();
  const results = await Promise.allSettled([
    mpp.challenge.tempo.charge(entries.tempo),
    mpp.challenge.stripe.charge(entries.stripe),
  ]);
  const labels = ["tempo", "stripe"];
  const headers: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      try {
        headers.push(Challenge.serialize(r.value));
      } catch (err) {
        console.error(`[mpp] challenge serialize failed (${labels[i]}):`, err);
      }
    } else {
      console.error(`[mpp] challenge mint failed (${labels[i]}):`, r.reason);
    }
  }
  return headers;
}

// Run mpp.compose() against the request and either: verify (and let the
// next handler run with the Payment-Receipt header stashed for emission
// on res.json/.send), or write back the 402 challenge response directly.
async function runMppCompose(
  req: Request,
  res: ResWithState,
  next: NextFunction,
  usd: string,
  description: string,
): Promise<void> {
  const entries = composeEntriesForUsd(usd, description);
  const webReq = reqToWebRequest(req);
  const result = await getMpp().compose(
    ["tempo/charge", entries.tempo],
    ["stripe/charge", entries.stripe],
    ["lightning/charge", entries.lightning],
  )(webReq);

  if (result.status === 402) {
    const challenge = result.challenge;
    res.status(challenge.status);
    for (const [k, v] of challenge.headers) res.setHeader(k, v);
    res.send(await challenge.text());
    return;
  }

  // Verified. Capture the Payment-Receipt header so route handlers that
  // emit JSON automatically carry it. Mirrors what mppx's payment()
  // helper does on the wrapped-express path.
  try {
    const wrapped = result.withReceipt(globalThis.Response.json({}));
    const receipt = wrapped.headers.get("Payment-Receipt");
    if (receipt) res.__mppReceiptHeader = receipt;
  } catch {
    // No receipt — verification still valid.
  }
  if (res.__mppReceiptHeader) {
    const origJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.__mppReceiptHeader) res.setHeader("Payment-Receipt", res.__mppReceiptHeader);
      return origJson(body);
    };
  }
  (req as ReqWithState).__mppPaid = true;
  next();
}

/**
 * Returns an Express middleware that gates a route on either x402 or MPP
 * payment. `usd` is the price as a dollar-denominated string (e.g. "0.05");
 * `description` is the human-readable payment description shown in the
 * Stripe checkout / Lightning invoice / Tempo charge memo.
 */
export function dualPay(usd: string, description: string): RequestHandler {
  return async (req, res, next) => {
    const r = res as ResWithState;
    const auth = String(req.headers.authorization ?? "");
    if (/^Payment\b/i.test(auth)) {
      try {
        await runMppCompose(req, r, next, usd, description);
      } catch (err) {
        next(err);
      }
      return;
    }

    if (req.headers["x-payment"]) {
      // x402 client — let the downstream paymentMiddleware handle.
      return next();
    }

    // No credential. Pre-build MPP challenges and set them as
    // WWW-Authenticate headers BEFORE handing off to x402. Express
    // preserves previously-set headers when emitting its 402, so the
    // single response carries both x402's X-PAYMENT-REQUIRED and MPP's
    // WWW-Authenticate: Payment. Setting via setHeader(name, array)
    // makes Node emit multiple WWW-Authenticate header lines (matches
    // Node's special handling for that header, mirroring Set-Cookie).
    //
    // Setting unconditionally on the no-credential path is safe because
    // x402's paymentMiddleware always emits 402 when X-PAYMENT is
    // absent — there's no success path that would leak the header.
    try {
      const headers = await buildChallengeHeaders(usd, description);
      if (headers.length > 0) {
        res.setHeader("WWW-Authenticate", headers);
      }
    } catch (err) {
      console.error("[mpp] challenge build failed:", err);
    }
    next();
  };
}

/**
 * Wraps the existing x402 paymentMiddleware so it short-circuits when the
 * MPP preflight has already verified the request. Without this, x402 would
 * see no `X-PAYMENT` header on an MPP-paid request and emit a 402.
 */
export function x402SkipIfMppPaid(x402: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if ((req as ReqWithState).__mppPaid) return next();
    return x402(req, res, next);
  };
}
