# Fuse Payments API (x402)

Production API for Fuse blockchain business & consumer payments using the x402 protocol.

## Live Deployment

- **URL**: https://fuse-payments-api.vercel.app
- **Network**: Base mainnet
- **Payment Token**: USDC

## Overview

This API provides x402 payment endpoints for:
- Blockchain analytics and insights
- Wallet management services  
- Business token information
- Consumer payment processing

## Dependencies

- `@x402/express@^2.10.0` - x402 Express middleware
- `@x402/core@^2.10.0` - Core x402 functionality
- `@x402/evm@^2.10.0` - EVM blockchain support
- `@coinbase/x402@^2.1.0` - Coinbase x402 integration
- `express@^5.2.1` - Web framework

## Quick Start

```bash
npm install
npm start
```

## Deployment

Deployed on Vercel under the fuse-labs scope:
- Automatic deployments from main branch
- Environment: Production
- Region: Auto

## x402 Protocol

This service implements the x402 payment protocol, enabling micropayments for API access. Each endpoint requires USDC payment on Base network before returning data.

## Usage

Make requests with x402-compatible clients that handle automatic USDC payments:

```bash
curl -H "x402-required: true" https://fuse-payments-api.vercel.app/api/endpoint
```

The service will return payment requirements for x402 clients to fulfill before providing the requested data.