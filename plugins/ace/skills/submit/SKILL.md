---
name: submit
description: Submit a scrubbed ACE capsule draft for Hermes review and founder approval. Requires ACE_AUTHORING_MODE so normal retrieval sessions do not pay tool-schema overhead.
---

# /ace:submit [path]

Submit a **scrubbed** local ACE draft to the registry review queue. This never publishes publicly; Hermes reviews, then the founder approves exact bytes.

Before calling `ace_submit`, tell the user exactly:

> This sends your scrubbed ACE draft to ACE for review. Do not submit secrets, credentials, private paths, PII, or raw session logs. Nothing will be published unless ACE review and founder approval pass.

Then call `ace_submit({"draft_path":"<path>"})` and report the returned submission id/status.
