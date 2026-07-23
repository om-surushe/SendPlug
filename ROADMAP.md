# Product roadmap

This file records deferred product work. Items here are not commitments to a release date.

## Public developer guide and private internal schema ([#2](https://github.com/om-surushe/SendPlug/issues/2))

- Replace the sidebar link to FastAPI Swagger with a curated developer guide.
- Document only the customer-facing send and delivery-status APIs.
- Include authentication, sender-scoped tokens, request fields, responses, errors, quotas, and copyable examples.
- Disable public Swagger, ReDoc, and OpenAPI schema routes in production.
- Keep internal admin and campaign-management endpoints out of the public guide.

## Product name and identity ([naming #6](https://github.com/om-surushe/SendPlug/issues/6), [favicon and identity #1](https://github.com/om-surushe/SendPlug/issues/1))

- **Selected product name:** SendPlug.
- **Positioning:** plug-and-play email infrastructure for new-age founders building SaaS, AI products, automations, and MVPs.
- **Product rhythm:** “Plug in. Send. See.” — integrate through the npm package/API, send product email, then use the dashboard and analytics.
- Build the identity around the selected modular-mail mark: two application components snapping together around a sending envelope.
- Final SVG, PNG, app-icon, and favicon assets live under `brand/final/`.
- Complete trademark review and acquire the chosen domain before the public product launch.
- Use descriptive page titles and landing copy for searches such as “plug-and-play email API,” “Gmail email API,” and “email API for founders.”

## Customer authentication and accounts ([#3](https://github.com/om-surushe/SendPlug/issues/3))

- Add managed sign-in, with WorkOS AuthKit as a candidate provider.
- Support Google sign-in and account recovery.
- Separate customer accounts, sender ownership, tokens, campaigns, and quotas.
- Preserve the existing administrator access path for operations and recovery.
- Add credits and usage accounting only after the account model is stable.

## Service status ([#4](https://github.com/om-surushe/SendPlug/issues/4))

- Add a public status page backed by an external uptime monitor.
- Monitor the public web application, API health, queue, Redis, worker, and Gmail relay checks separately.
- Show current state, recent incidents, and maintenance notices without exposing sensitive infrastructure details.

## Payments ([#5](https://github.com/om-surushe/SendPlug/issues/5))

- Evaluate Dodo Payments for checkout, subscriptions or credit packs, invoices, and taxes.
- Verify webhook signatures and make payment/credit updates idempotent.
- Do not grant credits from browser redirects; use confirmed server-side webhook events.
- Decide pricing and refund policy before implementation.

## Product decisions still required

- Production domain and trademark clearance for SendPlug.
- Self-hosted licence versus hosted service terms.
- One-time purchase, subscription, or prepaid credits.
- Trial limits and support expectations.
- Google App Password onboarding versus verified Google OAuth.
