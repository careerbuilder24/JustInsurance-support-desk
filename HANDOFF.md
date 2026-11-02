# JustInsurance Support Desk — Handoff

## 1. Summary

Implemented a safer support inbox workflow using Node.js and SQLite. The application supports tenant-scoped tickets, inbound webhook idempotency, explicit draft approval, controlled reply dispatch, delivery reconciliation, and human takeover.

## 2. Key Changes

- Tenant isolation enforced server-side using authenticated demo actors.
- Webhook events are authenticated and deduplicated by tenant and event ID.
- Webhook event persistence and its message/audit changes are transactional.
- Editing a draft invalidates its approval.
- Concurrent/repeated sends are guarded against duplicate dispatch.
- Delivery attempts are persisted before provider dispatch.
- Uncertain delivery is recorded as `UNKNOWN`; reconciliation checks provider evidence without blindly resending.
- Human takeover blocks subsequent automated dispatch.
- Inbox exposes ticket conversation, draft/approval, ownership, delivery state, and audit history.

## 3. Verification

- `npm test` — 12 tests passed, 0 failed.
- Webhook without secret — `401 Unauthorized`.
- Webhook with valid demo secret — `200 OK`, `accepted: true`.
- Replay of same tenant/event ID — `200 OK`, `duplicate: true`.
- Existing automated tests cover tenant isolation, duplicate/overlapping webhook replay, draft approval invalidation, concurrent send, provider rejection, UNKNOWN recovery/restart, and automation after takeover.

## 4. Operator Recovery: UNKNOWN Delivery

1. Do not resend an UNKNOWN reply.
2. Open the affected ticket and inspect the attempt/client reference.
3. Run **Reconcile** to query the provider for that same attempt.
4. If provider confirms delivery, mark the attempt delivered/SENT.
5. If provider returns `not_found` or lookup fails, keep UNKNOWN; this is inconclusive.
6. Escalate to provider logs/support and verify the customer's channel before any separately authorized action. Never blindly retry.

## 5. Real GHL Integration Before Rollout

This project uses a local mock provider, not the real HighLevel API. Before production rollout:

- Confirm the real GHL API endpoints, scopes, authentication/OAuth and account permissions.
- Verify webhook signature/authentication using GHL's documented mechanism; the current demo secret header is not production signature verification.
- Map real contact, conversation, message and organization IDs.
- Configure secure secrets, HTTPS callback URL, credential rotation and access controls.
- Test inbound events, duplicate/reordered events, outbound messages, provider timeouts and delivery-status lookup in a sandbox account.
- Verify provider delivery receipts and reconciliation behavior; confirm rate limits and error semantics.
- Complete security/privacy review, logging/monitoring, operational runbooks and rollback plan.

## 6. Limitations

- Demo bearer tokens and webhook secret are fictional fixtures.
- Mock provider is GHL-like and does not establish real GHL compatibility.
- No production OAuth, LLM, public deployment, distributed locking or multi-process database architecture.
- Real provider delivery semantics and webhook signature validation remain to be integrated and verified.

## 7. AI Use and Time

- AI tool used: ChatGPT for implementation guidance, code review/debugging and test planning.
- Accepted suggestion: add persistent UNKNOWN recovery/restart and overlapping webhook replay verification; verified by automated tests.
- Rejected suggestions: None.
- Actual time spent: **[30mnt]**.
