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
//      hook res.writeHead so x402's 402 also carries `WWW-Authenticate:
//      Payment …` headers (one per method). MPP clients reading WWW-
//      Authenticate get a real challenge; x402 clients reading X-PAYMENT-
//      REQUIRED keep working unchanged.

import { Challenge } from "mppx";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { composeEntriesForUsd, getMpp } from "../mpp.js";

// Per-request state. We tag req/res with these via intersection rather than
// module augmentation so the types stay local to this file (no global
// pollution; module-augment lookup is fragile under Express 5's type setup).
type ReqWithState = Request & { __mppPaid?: boolean };
type ResWithState = Response & {
  __mppChallengeHeaders?: string[];
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

// Hook res.writeHead so that whenever the downstream emits a 402 we also
// append a WWW-Authenticate: Payment header per MPP method. Idempotent —
// safe to install once per request.
function installWwwAuthInjector(res: ResWithState) {
  const orig = res.writeHead.bind(res);
  res.writeHead = function (this: ResWithState, status: number, ...rest: unknown[]) {
    if (status === 402) {
      for (const value of res.__mppChallengeHeaders ?? []) {
        res.append("WWW-Authenticate", value);
      }
    }
    // express's `res.writeHead` typing is the union of node's overloads;
    // delegate to the captured original to satisfy both shapes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any)(status, ...rest);
  } as typeof res.writeHead;
}

// Build per-method challenges for the no-credential WWW-Authenticate
// injection. Lightning is deliberately excluded here: Spark's `request()`
// hook mints a fresh BOLT11 invoice on every challenge generation by
// calling out to the Spark service, which would burn ~N invoices on every
// crawler hit. Lightning still surfaces to clients via the OpenAPI
// `x-payment-info.offers[]` and is verified at `Authorization: Payment`
// time when the client actually pays.
async function buildChallengeHeaders(usd: string, description: string): Promise<string[]> {
  const entries = composeEntriesForUsd(usd, description);
  const mpp = getMpp();
  const [tempo, stripe] = await Promise.all([
    mpp.challenge.tempo.charge(entries.tempo),
    mpp.challenge.stripe.charge(entries.stripe),
  ]);
  return [tempo, stripe].map(Challenge.serialize);
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

    // No credential. Pre-build MPP challenges so x402's 402 can carry them
    // as WWW-Authenticate headers. If challenge generation itself fails,
    // log and continue — x402 still emits a valid (x402-only) 402.
    try {
      r.__mppChallengeHeaders = await buildChallengeHeaders(usd, description);
      installWwwAuthInjector(r);
    } catch (err) {
      console.error("[mpp] challenge generation failed:", err);
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
