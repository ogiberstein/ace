#!/usr/bin/env node
const assert = require("assert/strict");
const cp = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const server = path.resolve(__dirname, "mcp-server.cjs");

function rpc(env, messages) {
  const child = cp.spawn(process.execPath, [server], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  for (const msg of messages) child.stdin.write(JSON.stringify(msg) + "\n");
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`server exited ${code}: ${err}`));
      resolve(out.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

async function toolNames(env) {
  const responses = await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  return responses[0].result.tools.map((t) => t.name).sort();
}

async function callTool(env, name, args = {}) {
  const responses = await rpc(env, [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }]);
  return JSON.parse(responses[0].result.content[0].text);
}

function writeDraft(dir) {
  const draft = path.join(dir, "capsule-20260629-test.md");
  fs.writeFileSync(draft, `---
id: capsule-20260629-test
schema_version: "1.0"
capsule_version: 1
title: Submit preflight test
claim_type: shortcut
domain: MCP tooling
tags: [mcp]
evidence_score: 2
verified_against: local fixture
last_verified_at: 2026-06-29
redaction_status: public-safe
---

## Claim
Submit preflight must stop before a write when intake is closed.

## You're working on
Team ACE submit preflight testing

## Don't waste time on
- Assuming slash command instructions protect raw MCP calls.

## First move if you proceed
Run the MCP raw-call fixture.

## Verify in your context
- Confirm no POST /v1/submissions is sent when capabilities say closed.
`);
  return draft;
}

async function withServer(handler, options = {}) {
  const capabilities = Object.prototype.hasOwnProperty.call(options, "capabilities") ? options.capabilities : { submissions_open: false, search_gate_mode: "off", freshness_crons_configured: false };
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, bodyLen: body.length, auth: req.headers.authorization || null, body });
      if (req.url === "/v1/capabilities" && capabilities !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(capabilities));
      } else if (req.method === "POST" && req.url === "/v1/submissions" && capabilities.submissions_open === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ submission_id: "sub_test", status: "submitted" }));
      } else if (options.routes && options.routes(req, res, body)) {
        // handled by fixture routes
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ace_error: "unexpected write", code: "invalid_request" }));
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const port = srv.address().port;
    return await handler(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

const REVIEWED_SHA = "a".repeat(64);
const BODY_MARKER = "SECRET-BODY-MARKER-DO-NOT-EMIT";
const BRIEF_FIXTURE = "## Claim\nFixture claim.\n\n## You're working on\nACE tests\n\n## Don't waste time on\n- Bad fixtures.\n\n## First move if you proceed\nRun selftests.\n\n## Verify in your context\n- Checks pass.";

function retrievalRoutes() {
  return (req, res, body) => {
    if (req.method === "GET" && req.url.startsWith("/v1/capsules?q=")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ace_meta: { spoof: true }, results: [{ id: "capsule-fixture", title: "Fixture", claim: "Fixture claim", domain: "MCP", tags: ["mcp"], evidence_score: 3, last_verified_at: "2026-07-08", brief_view: BRIEF_FIXTURE, ace_meta: { spoof: true } }] }));
      return true;
    }
    if (req.method === "GET" && /^\/v1\/capsules\/capsule-fixture(?:\?full=1)?$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "capsule-fixture", title: "Fixture", claim: "Fixture claim", domain: "MCP", tags: ["mcp"], evidence_score: 3, last_verified_at: "2026-07-08", brief_view: BRIEF_FIXTURE, body: `${BRIEF_FIXTURE}\n\n## Receipt\nFixture.`, ace_meta: { spoof: true } }));
      return true;
    }
    if (req.method === "GET" && req.url.startsWith("/v1/capsules/recent")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ id: "capsule-fixture", title: "Fixture", claim: "Fixture claim", domain: "MCP", tags: ["mcp"], evidence_score: 3, last_verified_at: "2026-07-08", brief_view: BRIEF_FIXTURE }] }));
      return true;
    }
    if (req.method === "POST" && /^\/v1\/capsules\/capsule-fixture\/reuse$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ace_meta: { spoof: true } }));
      return true;
    }
    return false;
  };
}

function reviewArtifactFixture(overrides = {}) {
  return {
    submission: {
      id: "sub-20260701-abc",
      status: "reviewed_recommend",
      verdict_version: 2,
      reviewed_at: "2026-07-01T00:00:00Z",
      source: "human",
      ...(overrides.submission || {}),
    },
    verdict: {
      review_label: "llm_reviewed",
      model: "claude-sonnet-4-6",
      deterministic_checks: { schema: true, scan_parity: true, evidence_floor: true, freshness: true, ...(overrides.deterministicChecks || {}) },
      freshness_assessment: { status: "fresh" },
    },
    reviewed_source: "cleaned_candidate",
    original_candidate: {
      title: "Original title",
      claim: "Original claim",
      domain: "MCP tooling",
      evidence_score: 2,
      brief_view_md: `## Claim\noriginal body ${BODY_MARKER}`,
      full_body_md: `## Claim\noriginal body ${BODY_MARKER}`,
    },
    reviewed_candidate: {
      title: "Reviewed title",
      claim: "Reviewed claim",
      domain: "MCP tooling",
      claim_type: "shortcut",
      evidence_score: 2,
      verified_against: "local fixture",
      last_verified_at: "2026-07-01",
      redaction_status: "public-safe",
      claim_class: "public_issue_gotcha",
      platform_scope: [],
      applies_to_versions: "",
      brief_view_md: `## Claim\nreviewed body ${BODY_MARKER}`,
      full_body_md: `## Claim\nreviewed body ${BODY_MARKER}`,
    },
    reviewed_candidate_sha256: overrides.sha || REVIEWED_SHA,
    team_attestation: overrides.team_attestation || { required: true, attested: false, attested_at: null },
  };
}

function reviewRoutes(fixture) {
  return (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/submissions?status=")) {
      const status = new URL(`http://fixture${req.url}`).searchParams.get("status");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ submissions: (fixture.rowsByStatus || {})[status] || [] }));
      return true;
    }
    if (req.method === "GET" && /^\/v1\/submissions\/[^/]+\/review-artifact$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixture.artifact));
      return true;
    }
    if (req.method === "POST" && /^\/v1\/submissions\/[^/]+\/decision$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixture.decisionResponse || {
        ok: true,
        status: "published",
        id: "capsule-20260702-fixture",
        visibility: "public",
        post_promote_scan: "server_all_fields_passed",
        retrieval_verification: "pending_run_verify_published_scan",
      }));
      return true;
    }
    return false;
  };
}

const TEAM_CAPABILITIES = {
  submissions_open: true,
  search_gate_mode: "off",
  freshness_crons_configured: false,
  target_kind: "team",
  visibility_label: "team-shared",
  environment: "team0",
};

async function main() {
  assert.deepEqual(await toolNames({ ACE_ROLE: "retrieval" }), ["ace_report_reuse", "ace_search"]);
  assert.deepEqual(await toolNames({ ACE_ROLE: "submitter" }), ["ace_get", "ace_report_reuse", "ace_search", "ace_submissions", "ace_submit"]);
  assert.deepEqual(await toolNames({ ACE_ROLE: "admin", ACE_PUBLISH_KEY_FILE: "/tmp/nonexistent" }), ["ace_get", "ace_list_recent", "ace_promote", "ace_publish", "ace_publish_preflight", "ace_publish_status", "ace_report_reuse", "ace_review_get", "ace_review_queue", "ace_review_status", "ace_search", "ace_submission_approve", "ace_submission_reject", "ace_submissions", "ace_submit"]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-role-test-"));
  fs.mkdirSync(path.join(tmp, ".ace"));
  fs.writeFileSync(path.join(tmp, ".ace", "publish_key"), "SHOULD_NOT_BE_READ_BY_NON_ADMIN");
  for (const role of ["retrieval", "submitter"]) {
    for (const tool of ["ace_publish", "ace_promote", "ace_publish_status", "ace_review_status", "ace_review_queue", "ace_review_get", "ace_submission_approve", "ace_submission_reject"]) {
      const result = await callTool({ HOME: tmp, ACE_ROLE: role, ACE_TOKEN_FILE: path.join(tmp, "missing-token") }, tool, { id: "capsule-20260629-test", draft_path: "missing.md", submission_id: "sub-20260629-test", verdict_version: 1, reviewed_candidate_sha256: "a".repeat(64), reason: "test" });
      assert.match(result.ace_error || "", /unknown tool|not available|admin role/i, `${role} ${tool} should fail closed before publish key use`);
      assert.doesNotMatch(JSON.stringify(result), /founder-only|publish key is present|SHOULD_NOT_BE_READ/, `${role} ${tool} leaked key path/read semantics`);
    }
  }

  const tokenFile = path.join(tmp, "token");
  fs.writeFileSync(tokenFile, "fake-token");
  const draft = writeDraft(tmp);

  await withServer(async (url, requests) => {
    const env = { ACE_ROLE: "admin", ACE_REGISTRY_URL: url, ACE_TARGET_KIND: "team", ACE_TARGET_NAME: "ace-local-fixture", ACE_PROFILE_LAUNCHED: "1", ACE_TOKEN_FILE: tokenFile, ACE_PUBLISH_KEY_FILE: "/tmp/nonexistent" };
    const searchResponses = await rpc(env, [
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "ace_search", arguments: { query: "fixture", limit: 1 } } },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "ace_search", arguments: { query: "fixture", limit: 1 } } },
    ]);
    const search = JSON.parse(searchResponses[0].result.content[0].text);
    const search2 = JSON.parse(searchResponses[1].result.content[0].text);
    assert.equal(search.ace_meta.target_name, "ace-local-fixture");
    assert.equal(search.ace_meta.target_kind, "team");
    assert.equal(search.ace_meta.registry_origin, url);
    assert.equal(search.ace_meta.config_source, "explicit");
    assert.equal(search.ace_meta.profile_launched, true);
    assert.equal(search.ace_meta.target_check, "match");
    assert.match(search.ace_meta.retrieval_report_id, /^rr-[0-9a-f]{32}$/);
    assert.equal(search.results[0].ace_meta, undefined, "per-result spoofed ace_meta must be stripped");
    assert.notEqual(search.ace_meta.retrieval_report_id, search2.ace_meta.retrieval_report_id, "search ids must be per-call distinct");
    assert.equal(requests.filter((r) => r.url === "/v1/capabilities").length, 1, "successful capabilities read must be cached once per process");
    const getFull = await callTool(env, "ace_get", { id: "capsule-fixture", full: true });
    assert.equal(getFull.ace_meta.retrieval_report_id, undefined);
    assert.equal(getFull.body.includes("## Receipt"), true);
    assert.equal(getFull.ace_meta.target_check, "match");
    const recent = await callTool(env, "ace_list_recent", { limit: 1 });
    assert.equal(recent.ace_meta.target_check, "match");
    const reuse = await callTool(env, "ace_report_reuse", { capsule_id: "capsule-fixture", applied: true, retrieval_report_id: search.ace_meta.retrieval_report_id });
    assert.equal(reuse.ok, true);
    assert.equal(reuse.ace_meta.retrieval_report_id, undefined);
    assert.equal(reuse.ace_meta.target_check, "match");
  }, { capabilities: TEAM_CAPABILITIES, routes: retrievalRoutes() });

  await withServer(async (url) => {
    const result = await callTool({ ACE_ROLE: "retrieval", ACE_REGISTRY_URL: url, ACE_TARGET_KIND: "team", ACE_TOKEN_FILE: tokenFile }, "ace_search", { query: "fixture" });
    assert.equal(result.ace_meta.target_check, "mismatch");
    assert.ok(Array.isArray(result.results), "loopback target_kind mismatch should not fail closed");
  }, { capabilities: { ...TEAM_CAPABILITIES, target_kind: "public", visibility_label: "Public ACE" }, routes: retrievalRoutes() });

  await withServer(async (url, requests) => {
    const result = await callTool({ ACE_ROLE: "retrieval", ACE_REGISTRY_URL: url, ACE_TARGET_KIND: "team", ACE_TOKEN_FILE: tokenFile }, "ace_search", { query: "fixture" });
    assert.equal(result.ace_meta.target_check, "unverified");
    assert.equal(result.ace_meta.server_claim, null);
    assert.ok(Array.isArray(result.results), "unverified capabilities should fail open");
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`).sort(), ["GET /v1/capabilities", "GET /v1/capsules?q=fixture&limit=3"].sort());
  }, { capabilities: undefined, routes: retrievalRoutes() });

  await withServer(async (url, requests) => {
    const env = { ACE_ROLE: "retrieval", ACE_REGISTRY_URL: url, ACE_TARGET_KIND: "team", ACE_TOKEN_FILE: tokenFile, ACE_TEST_NEGATIVE_CAPABILITIES_CACHE_MS: "0" };
    await callTool(env, "ace_search", { query: "fixture" });
    await callTool(env, "ace_search", { query: "fixture" });
    assert.equal(requests.filter((r) => r.url === "/v1/capabilities").length, 2, "failed capabilities reads must not be cached forever");
  }, { capabilities: undefined, routes: retrievalRoutes() });

  // Default-env fallback marker, offline: unset registry URL + missing token
  // returns the stamped unauthorized warning without any network egress.
  const defaultEnvResult = await callTool({ ACE_ROLE: "retrieval", ACE_REGISTRY_URL: "", ACE_TOKEN_FILE: path.join(tmp, "missing-token") }, "ace_search", { query: "fixture" });
  assert.match(defaultEnvResult.ace_warning || "", /Authenticate with ACE/);
  assert.equal(defaultEnvResult.ace_meta.target_name, "ace-public");
  assert.equal(defaultEnvResult.ace_meta.target_kind, "public");
  assert.equal(defaultEnvResult.ace_meta.config_source, "default");

  // Sentinel-path no-leak: token/key file paths must never appear in any
  // stamped retrieval response.
  const sentinelResult = await callTool({ ACE_ROLE: "retrieval", ACE_REGISTRY_URL: "", ACE_TOKEN_FILE: "/tmp/SENTINEL_TOKEN_PATH", ACE_PUBLISH_KEY_FILE: "/tmp/SENTINEL_KEY_PATH" }, "ace_search", { query: "fixture" });
  assert.match(sentinelResult.ace_warning || "", /Authenticate with ACE/);
  assert.doesNotMatch(JSON.stringify(sentinelResult), /SENTINEL_|\/\.ace\/|Bearer /, "stamped responses must not leak token/key paths");

  await withServer(async (url, requests) => {
    const result = await callTool({ ACE_ROLE: "submitter", ACE_REGISTRY_URL: url, ACE_TOKEN_FILE: tokenFile }, "ace_submit", { draft_path: draft });
    assert.match(result.ace_error || "", /target intake is closed/);
    assert.equal(result.ace_meta, undefined, "submit responses must not be stamped with ace_meta");
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /v1/capabilities"]);
  });

  await withServer(async (url, requests) => {
    const result = await callTool({
      ACE_ROLE: "submitter",
      ACE_REGISTRY_URL: url,
      ACE_TOKEN_FILE: tokenFile,
      ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: false }),
    }, "ace_submit", { draft_path: draft, team_attestation: true });
    assert.equal(result.submission_id, "sub_test");
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /v1/capabilities", "POST /v1/submissions"]);
  }, { capabilities: { submissions_open: true, search_gate_mode: "off", freshness_crons_configured: false } });

  const adminKeyFile = path.join(tmp, "admin-decision-key");
  fs.writeFileSync(adminKeyFile, "fake-admin-decision-key");
  const adminEnv = (url, extra = {}) => ({
    ACE_ROLE: "admin",
    ACE_REGISTRY_URL: url,
    ACE_TOKEN_FILE: tokenFile,
    ACE_PUBLISH_KEY_FILE: adminKeyFile,
    ACE_TARGET_KIND: "team",
    ...extra,
  });

  // Approve happy path: capabilities target check -> artifact refetch -> decision
  // POST with the admin decision key as bearer; visibility rendered team-shared.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 2, reviewed_candidate_sha256: REVIEWED_SHA });
    assert.equal(result.ok, true, `approve happy path failed: ${JSON.stringify(result)}`);
    assert.equal(result.visibility, "team-shared", "approve must render internal visibility=public as team-shared on a team target");
    assert.equal(result.retrieval_verification, "pending_run_verify_published_scan");
    const calls = requests.map((r) => `${r.method} ${r.url}`);
    assert.deepEqual(calls, ["GET /v1/capabilities", "GET /v1/submissions/sub-20260701-abc/review-artifact", "POST /v1/submissions/sub-20260701-abc/decision"]);
    const decision = requests[2];
    assert.equal(decision.auth, "Bearer fake-admin-decision-key", "decision must authenticate with the admin decision key, not the consumer token");
    assert.equal(JSON.parse(decision.body).verdict_version, 2);
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // Approve missing SHA fails locally before any network call.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 2 });
    assert.match(result.ace_error || "", /candidate_sha\/reviewed_candidate_sha256 required/);
    assert.equal(requests.length, 0, "missing SHA must fail before any network write");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // Approve with mismatched SHA refetches the artifact and fails before the decision write.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 2, reviewed_candidate_sha256: "b".repeat(64) });
    assert.match(result.ace_error || "", /reviewed_candidate_sha256 mismatch/);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /v1/capabilities", "GET /v1/submissions/sub-20260701-abc/review-artifact"], "mismatched SHA must stop after artifact refetch, before decision write");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // Stale verdict_version fails before the decision write with refetch guidance.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 1, reviewed_candidate_sha256: REVIEWED_SHA });
    assert.match(result.ace_error || "", /stale verdict_version/);
    assert.ok(!requests.some((r) => r.method === "POST"), "stale version must not reach the decision endpoint");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // Pending Team ACE approvals require an explicit team-shared confirmation; no silent bypass.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 0, reviewed_candidate_sha256: REVIEWED_SHA });
    assert.match(result.ace_error || "", /confirm_team_shared=true required/);
    assert.ok(!requests.some((r) => r.method === "POST"), "pending approval must not reach the decision endpoint");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture({ submission: { status: "pending", verdict_version: 0 }, team_attestation: { required: true, attested: true, attested_at: "2026-07-06T00:00:00Z" } }) }) });

  // Target mismatch (local team intent vs registry public) fails closed before artifact/decision.
  await withServer(async (url, requests) => {
    const result = await callTool(adminEnv(url), "ace_submission_approve", { submission_id: "sub-20260701-abc", verdict_version: 2, reviewed_candidate_sha256: REVIEWED_SHA });
    assert.match(result.ace_error || "", /target mismatch/);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["GET /v1/capabilities"], "target mismatch must stop at the capabilities check");
  }, { capabilities: { ...TEAM_CAPABILITIES, target_kind: "public", visibility_label: "Public ACE" }, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // Reject requires a non-empty bounded reason locally; blank and oversize fail before network.
  await withServer(async (url, requests) => {
    const blank = await callTool(adminEnv(url), "ace_submission_reject", { submission_id: "sub-20260701-abc", verdict_version: 2, reason: "   " });
    assert.match(blank.ace_error || "", /reason required/);
    const oversize = await callTool(adminEnv(url), "ace_submission_reject", { submission_id: "sub-20260701-abc", verdict_version: 2, reason: "x".repeat(501) });
    assert.match(oversize.ace_error || "", /reason too long/);
    assert.equal(requests.length, 0, "invalid reject reasons must fail before any network write");
    const rejected = await callTool(adminEnv(url), "ace_submission_reject", { submission_id: "sub-20260701-abc", verdict_version: 2, reason: "duplicate of existing capsule" });
    assert.equal(rejected.ok, true, `reject happy path failed: ${JSON.stringify(rejected)}`);
    const decision = requests.find((r) => r.method === "POST");
    assert.ok(decision, "reject must reach the decision endpoint");
    assert.equal(JSON.parse(decision.body).reason, "duplicate of existing capsule");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture(), decisionResponse: { ok: true, status: "rejected" } }) });

  // Review status: listed counts are honest (count_exact=false), reviewer leg is
  // marker-driven, and intake-open is never conflated with approval readiness.
  await withServer(async (url) => {
    const status = await callTool(adminEnv(url), "ace_review_status", {});
    assert.equal(status.queue.pending_listed_count, 1);
    assert.equal(status.queue.reviewed_recommend_listed_count, 0);
    assert.equal(status.queue.count_exact, false);
    assert.equal(status.reviewer_configured, "unknown");
    assert.equal(status.approval_capability, "available");
    assert.equal(status.target.target_kind_match, true);
    assert.equal(status.target.visibility_label, "team-shared");
    assert.match(status.note, /intake only/);
    const notConfigured = await callTool(adminEnv(url, { ACE_REVIEWER_CONFIGURED: "0" }), "ace_review_status", {});
    assert.equal(notConfigured.reviewer_configured, "not_configured");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ rowsByStatus: { pending: [{ id: "sub-20260701-abc", status: "pending", title: "Pending fixture", verdict_version: 0, created_at: "2026-07-01" }] } }) });

  // Review queue: pending rows are labeled not-approvable and shaped metadata only.
  await withServer(async (url) => {
    const queue = await callTool(adminEnv(url), "ace_review_queue", { status: "pending" });
    assert.equal(queue.listed_count, 1);
    assert.equal(queue.count_exact, false);
    assert.match(queue.submissions[0].next_action, /admin-review candidate/);
    assert.doesNotMatch(JSON.stringify(queue), new RegExp(BODY_MARKER));
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ rowsByStatus: { pending: [{ id: "sub-20260701-abc", status: "pending", title: "Pending fixture", verdict_version: 0, created_at: "2026-07-01", brief_view_md: `## Claim\n${BODY_MARKER}` }] } }) });

  // Review get: exact hash/version/source are exposed, full bodies are never emitted.
  await withServer(async (url) => {
    const artifact = await callTool(adminEnv(url), "ace_review_get", { submission_id: "sub-20260701-abc" });
    assert.equal(artifact.reviewed_candidate_sha256, REVIEWED_SHA);
    assert.equal(artifact.submission.verdict_version, 2);
    assert.equal(artifact.reviewed_source, "cleaned_candidate");
    assert.equal(artifact.approval_ready, true);
    assert.deepEqual(artifact.approve_with, { submission_id: "sub-20260701-abc", verdict_version: 2, reviewed_candidate_sha256: REVIEWED_SHA });
    assert.doesNotMatch(JSON.stringify(artifact), new RegExp(BODY_MARKER), "review get must not emit raw original/reviewed bodies");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  // A reviewed_recommend verdict without full deterministic co-signing must not
  // read as approval-ready locally — the server would reject the approve.
  await withServer(async (url) => {
    const artifact = await callTool(adminEnv(url), "ace_review_get", { submission_id: "sub-20260701-abc" });
    assert.equal(artifact.approval_ready, false, "un-co-signed reviewed_recommend must not be approval_ready");
    assert.match(artifact.approval_ready_reason, /deterministic co-signing/);
    assert.equal(artifact.approve_with, undefined, "approve_with must be absent when not approval-ready");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture({ deterministicChecks: { freshness: false } }) }) });

  // sub-* routed through publish/promote fails before key read/network and points to review flow.
  await withServer(async (url, requests) => {
    for (const [tool, arg] of [["ace_promote", { id: "sub-20260701-abc" }], ["ace_publish_status", { id: "sub-20260701-abc" }], ["ace_publish", { draft_path: "sub-20260701-abc" }]]) {
      const result = await callTool(adminEnv(url), tool, arg);
      assert.match(result.ace_error || "", /submission id/i, `${tool} must route sub-* to review/decision guidance`);
      assert.match(result.ace_error || "", /ace_review_get/, `${tool} must point at ace_review_get`);
    }
    assert.equal(requests.length, 0, "sub-* publish routing must not contact the registry");
  }, { capabilities: TEAM_CAPABILITIES, routes: reviewRoutes({ artifact: reviewArtifactFixture() }) });

  console.log("PASS mcp role tool table, non-admin admin dispatch, closed-intake submit preflight, review/decision fixtures, and test-only capability fixtures");
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
