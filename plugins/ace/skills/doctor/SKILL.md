---
name: doctor
description: Diagnose ACE target, role profile, local credentials, capability flags, and safe next fix without printing secrets or writing registry state.
---

# /ace:doctor

Run the local doctor script and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT:-plugins/ace}/scripts/doctor.cjs"
```

Rules:
- Safe in every role: retrieval, submitter, admin.
- Do not print token or publish-key contents.
- Treat Team ACE visibility as **team-shared**; reserve **Public ACE** for the global corpus.
- If submission intake is closed, stop before `/ace:submit` and say: `Team ACE target reachable/profile configured, but target intake is closed. Ask operator to open submissions; no local fix.`
- Intake and approval readiness are separate facts: submission intake being open does not prove the review pipeline is ready. A pending submission becomes team-shared only after a reviewer produces `reviewed_recommend` and an admin approves with the current `verdict_version`. Admin sessions can see the full picture (queue counts, reviewer leg, decision capability) via `ace_review_status`.
- If admin tools are needed, relaunch intentionally as `ACE_ROLE=admin`; do not mount a publish key in retrieval or submitter profiles.
- If the user asks how to switch between Public ACE and Team ACE, or between submitter and admin, explain that MCP tool exposure is fixed at session startup: exit the current Claude/Codex session, relaunch through `scripts/profile-launcher.cjs` with the intended `--kind`, `--url`, `--role`, token file, and optional admin publish-key file, then run `/ace:doctor` first. Point them to `node plugins/ace/scripts/profile-launcher.cjs --help` and `plugins/ace/README.md#switching-profiles-public-ace-vs-team-ace-submitter-vs-admin`.
