---
name: invite
description: Admin-only Team ACE colleague invitation. Resolve and confirm GitHub identity, upsert membership, then relay the helper-generated settings file and onboarding packet verbatim.
disable-model-invocation: true
---

# /ace:invite

Invite a colleague to the current isolated Team ACE instance from an intentional admin-folder session. Never run this from a normal project, Public ACE session, retrieval profile, or submitter profile.

The helper reads `ACE_REGISTRY_URL`, `ACE_TARGET_NAME`, `ACE_TARGET_KIND`, and `ACE_PUBLISH_KEY_FILE` from the admin-folder session. The admin key stays inside the helper: never read, print, echo, summarize, interpolate, or put its contents on argv.

## Required inputs

- GitHub login.
- The colleague's exact absolute home directory. If unknown, stop and ask the colleague to run `echo $HOME`; there is no default.
- Optional note. Notes must be printable ASCII and cannot contain quotes or backticks.

## Invite flow

1. Run the identity-only phase using the skill-relative 8c path pattern:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/invite-member.cjs" "<github-login>" --home "<absolute-home>" --resolve-only
   ```

   Add `--note "<safe-note>"` only when the admin supplied one. Pass each value as a separate argument. Do not rewrite or evaluate user-provided text.

2. Show the helper's resolved GitHub profile to the admin: login, numeric id, display name, and profile URL. Ask for explicit confirmation that this is the intended colleague. **Stop here until the admin confirms.** A successful `--resolve-only` run performs no membership POST.

3. Only after explicit confirmation, run the same command with `--confirmed` instead of `--resolve-only`:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/invite-member.cjs" "<github-login>" --home "<absolute-home>" --confirmed
   ```

   Preserve the same `--note` value, if any. Do not infer confirmation from the original `/ace:invite` request; confirmation happens after the resolved profile is displayed.

4. On success, relay the helper's stdout packet to the admin **verbatim and in full**. Do not edit, reformat, summarize, or regenerate either artifact. The helper owns the exact standalone settings JSON and the zero-placeholder, one-paste onboarding block; the colleague should paste that block rather than save or reconstruct the JSON manually.

## Upsert semantics

The members API is idempotent by numeric GitHub id. Re-inviting an existing id succeeds as `invited or updated (upsert)` and overwrites that row's `github_login` and `note`; the API cannot distinguish insert from update. The registry currently records `added_by='founder'` even on friend-admin instances; that audit-label limitation is deferred to a registry-side follow-up.

## List members

From the admin folder:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/invite-member.cjs" --list
```

The helper emits only GitHub login and numeric id. It does not emit notes or credential material.

## Removal

Removal is operator-only for now: `DELETE /v1/admin/members/:id`. There is no `/ace:invite` removal UX in this version. Do not improvise a key-bearing shell command or expose the admin key; route removal to the operator procedure.

## Failure rules

- Missing or malformed admin-key configuration: stop and tell the user to launch Claude from `~/ace-admin-<slug>/` and retry.
- Wrong/unverifiable target plane: stop and run `/ace:doctor`; never bypass the capabilities gate.
- GitHub not-found or rate-limit: relay the helper's fixed recovery message; do not guess an id.
- Any registry refusal, invalid response, or timeout: relay the fixed recovery message. Never include response bodies or key contents.
