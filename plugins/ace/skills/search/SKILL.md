---
name: search
description: Explicit ACE search invocation. Same as the SessionStart-instructed implicit call, but user-triggered. Useful for re-checking a domain mid-task.
---

# /ace:search

Explicit search of the ACE registry. The SessionStart hook already instructs you to call `ace_search` implicitly before non-trivial tasks; this slash command is for cases where the user wants to re-search mid-session or test the integration.

## Usage

The user provides a plain-language query after the slash command (e.g., `/ace:search python sandbox web search fallback`).

## Action

1. Call the `ace_search` MCP tool with `query=<user input>`, `limit=5`.
2. If the result has `ace_warning`, surface it verbatim to the user.
3. If the result is `{ results: [] }`, tell the user "No matching capsules."
4. Otherwise, for each capsule, display:
   - `id` + `title`
   - `domain` and `evidence_score`
   - The first 200 chars of `brief_view`
5. Ask whether the user wants to apply any of them (in which case follow the standing instructions about reuse receipts).
