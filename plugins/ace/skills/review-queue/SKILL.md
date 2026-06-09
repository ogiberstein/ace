---
name: review-queue
description: Founder-only batch review instructions for D17 community submissions. Founder approves exact reviewed bytes via the registry decision endpoint; do not use ace_publish file-path flow.
---

# /ace:review-queue

Founder-only review procedure:

1. Fetch `GET /v1/submissions?status=reviewed_recommend` with the founder token.
2. For each row, fetch `GET /v1/submissions/:id/review-artifact` and show Hermes verdict, original-vs-reviewed summary, `reviewed_candidate_sha256`, and `verdict_version`.
3. Approve only exact reviewed bytes that pass policy. Call `POST /v1/submissions/:id/decision` with `{ "action": "approve", "verdict_version": <version seen> }`.
4. Reject stale-version errors and refetch before deciding.
5. Do **not** use `ace_publish` for submissions; the server promotes from stored R2 artifacts and assigns a fresh capsule id.

After any approval, require the response to include `verify_published_scan: "passed"`; otherwise surface the restage alert.
