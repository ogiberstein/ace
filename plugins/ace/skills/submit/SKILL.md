---
name: submit
description: Submit a scrubbed ACE capsule draft for review. Requires a submitter/admin role profile; submitter exposes submit tools but never publish/promote/status tools.
---

# /ace:submit [path]

Submit a **scrubbed** local ACE draft to the active ACE review queue. This never publishes to Public ACE or Team ACE team-shared visibility; review/admin approval is a separate step.

## Action

1. Run the submit preflight first:

```bash
node "${CLAUDE_PLUGIN_ROOT:-plugins/ace}/scripts/doctor.cjs" --submit-preflight
```

2. Stop if doctor reports:
   - role is `retrieval`;
   - a publish key is mounted in `submitter` mode;
   - the target capability endpoint says `SUBMISSIONS_OPEN=0` / intake closed.

Closed-intake wording when `/v1/capabilities` is live:

> Team ACE target reachable/profile configured, but target intake is closed. Ask operator to open submissions; no local fix. The local draft remains unchanged.

Unknown-intake wording while `/v1/capabilities` is not deployed on the target:

> The target does not expose `/v1/capabilities` yet, so local preflight cannot prove intake is closed before submission. Closed-intake protection is still enforced by the registry `/v1/submissions` server-side 503; the local draft remains unchanged if the server rejects it.

3. Before calling `ace_submit`, tell the user exactly:

> This sends your scrubbed ACE draft to ACE for review. Do not submit secrets, credentials, private paths, PII, or raw session logs. Nothing will become Public ACE or Team ACE team-shared unless review and admin approval pass.

4. Call `ace_submit({"draft_path":"<path>"})` and report the returned submission id/status.

## Role rule

Submitter mode may expose `ace_search`, `ace_report_reuse`, `ace_get`, `ace_submit`, and `ace_submissions`. It must never expose or dispatch `ace_publish`, `ace_promote`, or `ace_publish_status`.
