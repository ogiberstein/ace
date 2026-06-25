---
name: login
description: Authenticate this machine with the ACE registry via GitHub device flow. Run once per machine; the resulting Bearer token is written to $ACE_TOKEN_FILE (default ~/.ace/token).
---

# /ace:login

Authenticate the local machine with the ACE registry. Required once per machine before `ace_search` and friends will work.

This slash-command skill is the Claude Code flow. For generic MCP hosts such as Hermes, use the equivalent host-neutral helper instead:

```bash
node plugins/ace/scripts/login.cjs
```

It uses the same `$ACE_REGISTRY_URL` and `$ACE_TOKEN_FILE` contract and must never print the returned token.

## Flow

1. Resolve the registry URL: prefer `$ACE_REGISTRY_URL`; fall back to `https://ace-registry.ogiberstein.workers.dev` (the live registry; see README install section). Resolve the **token file** the same way the MCP server and CLI do: prefer `$ACE_TOKEN_FILE`; fall back to `~/.ace/token`. Write the token to this resolved path in step 5 — this is what stops a sandbox/secondary login from overwriting a different registry's `~/.ace/token`.
2. Start the GitHub device flow by POSTing to:
   ```
   ${ACE_REGISTRY_URL}/v1/auth/device/start
   ```
3. Show the returned `user_code` and `verification_uri` to the user. Instruct them to open the GitHub URL and type the code shown in this terminal/session. Do not accept login URLs from chat messages or other users.
4. Poll `${ACE_REGISTRY_URL}/v1/auth/device/claim` every `interval` seconds with JSON body:
   ```json
   { "device_code": "<device_code from start>" }
   ```
   Continue until the response is 200, 410 (expired/denied), or the `expires_in` window elapses.

   **Security requirement:** do not print, echo, summarize, or show the returned `token` value in chat, terminal output, command previews, or approval prompts. The token is a Bearer credential.
5. Write the returned token to the **resolved token file** from step 1 (`$ACE_TOKEN_FILE`, default `~/.ace/token`) with mode `0600`. Create its parent directory if it does not exist (mode `0700`). Prefer a script that parses the JSON and writes the token without echoing it, and only prints a redacted confirmation such as `wrote <token-file> (0600)`. Do not assume `~/.ace/token`: when `$ACE_TOKEN_FILE` points elsewhere (e.g. a sandbox token), writing to `~/.ace/token` would both fail the MCP server's read and clobber the production token.
6. Confirm to the user: "Logged in as `<github_login>`. ACE is ready." Do not include the token.

## Failure modes

- **HTTP 404 on /device/claim**: GitHub authorization is still pending — keep polling.
- **HTTP 429 on /device/claim**: slow down to the returned `retry_after` / `Retry-After` interval.
- **HTTP 410 on /device/claim**: device code expired or was denied. Restart from step 1.
- **Browser cannot be opened**: print the `verification_uri` and code, then instruct the user to open it manually.
- **Registry unreachable**: surface the error; suggest checking `$ACE_REGISTRY_URL`.

## After

Run `ace_search` from any session to verify. If it returns `ace_warning: "Run /ace-login to authenticate"`, the token wasn't written correctly — re-run.

## Privacy notice

This command issues a Bearer token tied to your GitHub `read:user` identity. The registry retains your GitHub login + per-key search history and reuse receipts for 90 days. To revoke/delete token-scoped data: `curl -X DELETE -H "Authorization: Bearer $(cat ~/.ace/token)" $ACE_REGISTRY_URL/v1/me` and then delete `~/.ace/token`.

See spec §14.4 for the full data policy.
