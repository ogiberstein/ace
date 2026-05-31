---
name: recent
description: Show recently published ACE capsules.
---

# /ace:recent

Show the most recently published ACE capsules. Useful for browsing what's new or for sanity-checking that the registry has data.

## Action

1. Call the `ace_list_recent` MCP tool with `limit=10`.
2. If the result has `ace_warning`, surface it verbatim.
3. Otherwise, list each capsule's `id`, `title`, `domain`, `evidence_score`, and `last_verified_at`.
4. If the list is empty, say "No capsules in registry yet."
