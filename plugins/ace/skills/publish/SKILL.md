---
name: publish
description: Founder-only. Publish a reviewed capsule draft to the ACE registry in one step (staging by default), via the ace_publish MCP tool — no terminal or founder-key handling needed. Use after /ace:capture.
---

# /ace:publish

One-step publish of a capsule draft to the registry, for the founder. Replaces the terminal `ace publish` / `ace promote` flow: the `ace_publish` MCP tool reads the founder key directly, so there's no key juggling and no sandbox issue.

This is founder-only. On a machine without `~/.ace/publish_key`, `ace_publish` returns a founder-only error — that's expected for consumers.

## Usage

- `/ace:publish <path-to-draft.md>` — publish to **staging** (default; not yet consumer-visible).
- `/ace:publish <path-to-draft.md> public` — publish and immediately promote to **public**.
- `/ace:publish <capsule-id> public` — check founder publish status, then promote an already-staged capsule to public if ready (no draft needed).

If no path is given, use the draft this session just created (e.g. the most recent file under `./.ace-drafts/` or `~/.ace/drafts/`).

## Action

1. **Resolve intent:**
   - A `.md` path → publish that draft. The word `public` after it → also promote.
   - A bare `capsule-…` id + `public` → promotion only: call `ace_publish_status(id=<id>)` first. If `ok_to_promote=false`, report all blockers and stop. If ready, call `ace_promote(id=<id>)`.

2. **Pre-publish review (do not skip):** read the draft and re-run the spec §5.2 portabilization audit lens —
   - **Hard blocks** (secrets, credentials, tokens, PII for anyone but the founder, injection patterns): refuse; tell the founder to fix the draft first.
   - **Soft blocks** (internal paths, internal IDs, repo/channel/project names, project-specific vocabulary): list them and ask the founder to confirm or edit before publishing.
   - Confirm the receipt content fits the five evidence types (numbers / sanitized errors / repro commands / public links / abstracted artifacts).
   Summarize: "N hard / M soft / K non-standard receipt items." If hard blocks exist, stop.

3. **Public readiness preflight:** if publishing to public, the tool will require `redaction_status: public-safe`, scan all agent-visible fields, and either generate a stable-behavior freshness assessment or return one complete blocker checklist. Do not manually edit YAML by trial-and-error.

4. **Confirm with the founder** what will happen ("Publish `<id>` to staging" or "…to public"). The founder approving the `ace_publish` tool call is the publish gate.

5. **Call `ace_publish`** with `draft_path=<resolved path>` and `to_public=true` only if the founder asked for public. Default `to_public=false` (staging).

6. **Report** the returned `id` and `visibility`. If staging, remind the founder they can later run `/ace:publish <id> public` to check readiness and promote. If promotion fails with readiness blockers such as `freshness_status: needs_review`, do **not** say to retry blindly; say the exact action, usually republish the draft with a passing `freshness_assessment`.

## Notes

- Staging-by-default is intentional: a misfire lands in staging (not served to consumers) until a deliberate promote. Don't pass `to_public=true` unless the founder explicitly asked.
- The registry re-validates and re-scans every field server-side; a malformed draft returns a 400 with the reason — relay it.
- Publishing is rate-limited per founder token (currently 100/day) — a `rate_limited` response includes `retry_after` seconds.
