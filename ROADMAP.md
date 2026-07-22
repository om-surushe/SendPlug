# Product roadmap

This file records deferred product work. Items here are not commitments to a release date.

## Public developer guide and private internal schema

- Replace the sidebar link to FastAPI Swagger with a curated developer guide.
- Document only the customer-facing send and delivery-status APIs.
- Include authentication, sender-scoped tokens, request fields, responses, errors, quotas, and copyable examples.
- Disable public Swagger, ReDoc, and OpenAPI schema routes in production.
- Keep internal admin and campaign-management endpoints out of the public guide.

## Product identity

- Choose the product name before replacing the temporary **SMTP Console** label.
- Add a favicon and final logo in all required browser/PWA sizes.
- Use a descriptive page title and landing-page copy for searches such as “self-hosted email API” and “Gmail SMTP API for developers.”

## Customer authentication and accounts

- Add managed sign-in, with WorkOS AuthKit as a candidate provider.
- Support Google sign-in and account recovery.
- Separate customer accounts, sender ownership, tokens, campaigns, and quotas.
- Preserve the existing administrator access path for operations and recovery.
- Add credits and usage accounting only after the account model is stable.

## Service status

- Add a public status page backed by an external uptime monitor.
- Monitor the public web application, API health, queue, Redis, worker, and Gmail relay checks separately.
- Show current state, recent incidents, and maintenance notices without exposing sensitive infrastructure details.

## Payments

- Evaluate Dodo Payments for checkout, subscriptions or credit packs, invoices, and taxes.
- Verify webhook signatures and make payment/credit updates idempotent.
- Do not grant credits from browser redirects; use confirmed server-side webhook events.
- Decide pricing and refund policy before implementation.

## Product decisions still required

- Public product name and domain.
- Self-hosted licence versus hosted service terms.
- One-time purchase, subscription, or prepaid credits.
- Trial limits and support expectations.
- Google App Password onboarding versus verified Google OAuth.
