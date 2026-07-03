---
name: publish
description: Admin-only. Publish a reviewed capsule draft to staging and promote to Public ACE or Team ACE team-shared visibility via the ace_publish/ace_promote MCP tools. Use after /ace:capture.
---

# /ace:publish

One-step admin publish of a capsule draft to the active ACE target. The target decides the user-facing visibility language:

- **Public ACE** target: `public` means globally public.
- **Team ACE** target: use **team-shared** for user-facing copy; internal APIs may still call this `public` visibility inside that isolated instance.

This command is available only in an intentional `ACE_ROLE=admin` profile. Retrieval and submitter profiles must not expose `ace_publish`, `ace_promote`, or `ace_publish_status`.

## Usage

- `/ace:publish <path-to-draft.md>` — publish to **staging** (default; not yet visible to consumers/team members).
- `/ace:publish <path-to-draft.md> public` — Public ACE only: publish and immediately promote to public.
- `/ace:publish <path-to-draft.md> team-shared` — Team ACE only: publish and immediately promote to team-shared.
- `/ace:publish <capsule-id> public|team-shared` — check `ace_publish_status(id=<id>)`, then promote an already-staged capsule only if ready.

If no path is given, use the draft this session just created.

## Action

1. Run `/ace:doctor` first. Stop if the role is not `admin`, the target is wrong, or the publish key is missing.
   - A `sub-*` argument is a **submission id**, not a draft or capsule. Do not publish it: route to `/ace:review-queue` (`ace_review_get`, then `ace_submission_approve`/`ace_submission_reject` after a reviewer recommendation). The publish tools refuse `sub-*` before reading the publish key or contacting the registry.
2. Resolve intent:
   - A `.md` path → publish that draft to staging.
   - A `.md` path + `public`/`team-shared` → publish then promote if readiness passes.
   - A bare `capsule-…` id + `public`/`team-shared` → promotion only: call `ace_publish_status` first. If `ok_to_promote=false`, report all blockers and stop.
3. For a `.md` path, run `ace_publish_preflight(draft_path=<path>)` before asking for approval. This is the local readiness preflight aligned with registry redaction/scanner/freshness-class blockers: it does not read the publish key or post to the registry, and it returns blockers together. Registry publish remains the final boundary. Fix every blocker before publish/promote.
4. Pre-publish review (do not skip): secrets/credentials/tokens/PII/injection patterns hard-block; internal paths/IDs/repo/channel/project vocabulary require explicit rewrite/confirmation.
5. Ask for explicit approval for the publish/promote action after preflight is clean.
6. Call `ace_publish` with `to_public=true` only when the user approved immediate `public`/`team-shared` promotion. Default `to_public=false`.
7. Report returned `id` and visibility, mapping Team ACE `public` responses to **team-shared**. If promotion fails on redaction/freshness readiness, say the exact blocker and the fix: republish a corrected draft with `redaction_status: public-safe` and valid freshness assessment; do not suggest terminal YAML trial-and-error.

## Publish-readiness cheat sheet

These gates are intentional; do not weaken them or bypass them for founders/admins:

- `redaction_status` must be `public-safe` for public/team-shared promote. `reviewed` is staging-only.
- `claim_class` drives freshness auto-generation. Only `posture` and `stable_behavior` auto-generate a `fresh` assessment. Version tokens like `2.1`, bug verbs such as `broken`/`fails`/`regression`, or strict repo mentions like `anthropics/claude-code`, `openai/codex`, or `modelcontextprotocol/*` make the effective class `tool_bug_version_pinned` and require explicit freshness fields.
- Allowed `##` headings are exactly: `Claim`, `You're working on`, `Don't waste time on`, `First move if you proceed`, `Verify in your context`, `Receipt`, `When this stops applying`, `Reuse evidence`. Any other section can trip `unknown_section`.
- The scanner blocks exfil-shaped text: `print|reveal|dump|upload|leak` near `token|secret|api key|password|credential`, plus direct asks such as `show/tell/give me ... token` or `include ... contents of ... token`. Capsules about credential hygiene are most likely to trip this legitimately; phrase them as safety posture, not as instructions to disclose secrets.

## CLI parity

- `ace publish --dry-run <draft.md>` runs the aligned local readiness preflight from a terminal and exits nonzero if any blocker remains.
- `ace lint <draft.md>` is schema-only. Passing lint is not publish readiness; use dry-run for redaction/scanner/freshness gates.

## Notes

- Staging-by-default is intentional.
- Team ACE team-shared is not Public ACE and does not touch the global corpus.
- Publishing is rate-limited per admin token; relay `rate_limited` with `retry_after` if returned.
