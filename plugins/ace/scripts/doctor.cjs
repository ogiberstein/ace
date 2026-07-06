#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const assert = require("assert/strict");

function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith("${");
}
function envOrDefault(value, fallback) {
  if (!value || isPlaceholder(String(value))) return fallback;
  return value;
}
function envIsSet(env, key) {
  return !!env[key] && !isPlaceholder(String(env[key]));
}
function truthy(value) { return /^(1|true|yes)$/i.test(String(envOrDefault(value, "") || "")); }
function roleOf(env) {
  const raw = String(envOrDefault(env.ACE_ROLE, "")).toLowerCase();
  if (["retrieval", "submitter", "admin"].includes(raw)) return raw;
  if (truthy(env.ACE_ADMIN_MODE)) return "admin";
  if (truthy(env.ACE_SUBMIT_MODE)) return "submitter";
  if (truthy(env.ACE_AUTHORING_MODE)) return "admin"; // legacy compatibility
  return "retrieval";
}
function legacyAuthoringAdmin(env) {
  const raw = String(envOrDefault(env.ACE_ROLE, "")).toLowerCase();
  return !["retrieval", "submitter", "admin"].includes(raw) && !truthy(env.ACE_ADMIN_MODE) && !truthy(env.ACE_SUBMIT_MODE) && truthy(env.ACE_AUTHORING_MODE);
}
function targetKindOf(env, url) {
  const kind = String(envOrDefault(env.ACE_TARGET_KIND, "")).toLowerCase();
  if (kind === "team" || kind === "public") return kind;
  return /ace-registry\.ogiberstein\.workers\.dev/.test(url) ? "public" : "team";
}
function label(kind) { return kind === "team" ? "Team ACE" : "Public ACE"; }
function visibility(kind) { return kind === "team" ? "team-shared" : "Public ACE"; }
function tokenFile(env) { return envOrDefault(env.ACE_TOKEN_FILE, path.join(os.homedir(), ".ace", "token")); }
function publishKeyFile(env, role) { return role === "admin" ? envOrDefault(env.ACE_PUBLISH_KEY_FILE, path.join(os.homedir(), ".ace", "publish_key")) : envOrDefault(env.ACE_PUBLISH_KEY_FILE, ""); }
function exists(p) { return !!p && fs.existsSync(p); }
function capabilities(role, cap, opts = {}) {
  const retrieval = true;
  const publish = role === "admin";
  let submit = role === "submitter" || role === "admin";
  let submitLabel = submit ? "yes" : "no";
  if (submit && cap && cap.submissions_open === false) submitLabel = "configured-but-target-closed";
  if (submit && cap === null) submitLabel = opts.startup ? "not probed at startup" : "configured-but-target-unknown";
  return { retrieval, submit, publish, submitLabel };
}
function parseCapabilities(env) {
  const fixtureEnabled = truthy(env.ACE_TEST_CAPABILITIES_FIXTURE) || env.ACE_CAPABILITIES_SOURCE === "runtime_fetch";
  if (!fixtureEnabled) return undefined;
  if (env.ACE_CAPABILITIES_JSON) return JSON.parse(env.ACE_CAPABILITIES_JSON);
  if (env.ACE_CAPABILITIES_FIXTURE_FILE) return JSON.parse(fs.readFileSync(env.ACE_CAPABILITIES_FIXTURE_FILE, "utf8"));
  return undefined;
}
async function fetchCapabilities(registryUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${registryUrl}/v1/capabilities`, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "ace-doctor/0.1" } });
    if (!resp.ok) return undefined;
    return await resp.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
function listActualTools(env) {
  const server = path.join(__dirname, "mcp-server.cjs");
  const child = cp.spawnSync(process.execPath, [server], {
    env: { ...process.env, ...env },
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    encoding: "utf8",
    timeout: 3000,
  });
  if (child.status !== 0 || !child.stdout.trim()) return undefined;
  const line = child.stdout.trim().split(/\n/).filter(Boolean)[0];
  return JSON.parse(line).result.tools.map((t) => t.name).sort();
}
function expectedTools(role, env) {
  const tools = ["ace_search", "ace_report_reuse"];
  if (truthy(env.ACE_EXPOSE_GET) || role === "submitter" || role === "admin") tools.push("ace_get");
  if (role === "submitter" || role === "admin") tools.push("ace_submit", "ace_submissions");
  if (role === "admin") {
    tools.push(
      "ace_list_recent",
      "ace_publish",
      "ace_publish_preflight",
      "ace_promote",
      "ace_publish_status",
      "ace_review_get",
      "ace_review_queue",
      "ace_review_status",
      "ace_submission_approve",
      "ace_submission_reject",
    );
  }
  return tools.sort();
}
function diagnose(env = process.env, opts = {}) {
  const role = roleOf(env);
  const explicitRegistryUrl = envIsSet(env, "ACE_REGISTRY_URL");
  const registryUrl = envOrDefault(env.ACE_REGISTRY_URL, "https://ace-registry.ogiberstein.workers.dev").replace(/\/$/, "");
  const targetName = envOrDefault(env.ACE_TARGET_NAME, /ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl) ? "ace-public" : "ace-target");
  const kind = targetKindOf(env, registryUrl);
  const token = tokenFile(env);
  const pub = publishKeyFile(env, role);
  const cap = parseCapabilities(env);
  const caps = capabilities(role, cap === undefined ? null : cap, { startup: opts.startup === true });
  const actualTools = env.ACE_ACTUAL_TOOLS_JSON ? JSON.parse(env.ACE_ACTUAL_TOOLS_JSON) : undefined;
  const warnings = [];
  if (!explicitRegistryUrl) warnings.push("ACE_REGISTRY_URL unset; using built-in Public ACE default. If this session should use Team ACE, this is a likely miswire.");
  if (kind === "team" && /ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl)) warnings.push("Team ACE profile points at Public ACE production URL");
  if (kind === "public" && !/ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl)) warnings.push("Public ACE profile points at a non-production/isolated URL");
  const driftVars = ["ACE_REGISTRY_URL", "ACE_TOKEN_FILE", "ACE_PUBLISH_KEY_FILE", "ACE_ROLE", "ACE_AUTHORING_MODE", "ACE_SUBMIT_MODE", "ACE_ADMIN_MODE", "ACE_CAPABILITIES_JSON", "ACE_CAPABILITIES_FIXTURE_FILE"].filter((k) => envIsSet(env, k) && !truthy(env.ACE_PROFILE_LAUNCHED));
  if (driftVars.length) warnings.push(`global/default ACE env without ACE_PROFILE_LAUNCHED=1: ${driftVars.join(", ")}`);
  if (legacyAuthoringAdmin(env)) warnings.push("legacy ACE_AUTHORING_MODE=1 resolved to admin; relaunch with ACE_ROLE=admin instead");
  if ((role === "retrieval" || role === "submitter") && pub && pub !== "__ACE_NO_PUBLISH_KEY__") warnings.push(`${role} profile has a publish-key path set; fail closed and relaunch without it`);
  const expected = expectedTools(role, env);
  if (actualTools && JSON.stringify(actualTools) !== JSON.stringify(expected)) warnings.push(`MCP tool table mismatch: expected ${expected.join(",")} actual ${actualTools.join(",")}`);
  if (role === "admin" && !exists(pub)) warnings.push("admin profile missing publish key file");
  const intake = cap === undefined ? "unknown (target does not expose/provide capability status yet; until /v1/capabilities is deployed on this target, closed-intake protection is enforced by the registry /v1/submissions server-side 503, not by local preflight)" : (cap.submissions_open ? "open" : "closed — SUBMISSIONS_OPEN=0 on target; local preflight stops before submit while /v1/capabilities is live");
  let next = "No action; profile healthy";
  if (warnings.some((w) => /publish-key path/.test(w))) next = "Relaunch without ACE_PUBLISH_KEY_FILE in retrieval/submitter profile";
  else if (warnings.some((w) => /missing publish key/.test(w))) next = "Relaunch admin profile with ACE_ADMIN_MODE=1 and ACE_PUBLISH_KEY_FILE set";
  else if (role === "submitter" && cap && cap.submissions_open === false) next = "Ask operator to open Team ACE submissions; no local fix";
  else if (driftVars.length) next = "Exit and relaunch via an ACE role profile";
  else if (!explicitRegistryUrl && (kind === "team" || role === "submitter" || role === "admin")) next = "If this should use Team ACE, relaunch with explicit ACE_REGISTRY_URL; otherwise this Public ACE default warning is informational";
  else if (!exists(token)) next = "Run /ace:login in this profile";
  return { role, registryUrl, explicitRegistryUrl, targetName, kind, token, pub, cap, caps, warnings, intake, next, tools: expected, actualTools };
}
function render(mode, env = process.env) {
  const d = diagnose(env, { startup: mode === "startup" });
  const lines = [];
  lines.push(`ACE target: ${label(d.kind)} ${d.targetName} (${d.registryUrl})`);
  lines.push(`ACE role: ${d.role}`);
  lines.push(`Capabilities: retrieval=yes, submit=${d.caps.submitLabel}, publish=${d.caps.publish ? "yes" : "no"}`);
  lines.push(`Retrieval wiring: agent-initiated via SessionStart → ${d.targetName} (${d.kind})${d.explicitRegistryUrl ? "" : " [built-in default URL]"}`);
  lines.push(`Token file: ${d.token ? `configured ${exists(d.token) ? "+ present" : "+ missing"} (${d.token}; contents hidden)` : "absent"}`);
  lines.push(`Publish key: ${d.pub ? `configured ${exists(d.pub) ? "+ present" : "+ missing"} (${d.pub}; contents hidden)` : (d.role === "admin" ? "missing" : "absent")}`);
  lines.push(`Submission intake: ${mode === "startup" && d.cap === undefined ? "not probed at startup — run /ace:doctor for live state" : d.intake}`);
  lines.push(`Visibility language: ${visibility(d.kind)}${d.kind === "team" ? " inside this Team ACE instance; not Public ACE" : " global corpus"}`);
  if (mode !== "startup") {
    lines.push(`Advertised tools expected: ${d.tools.join(", ")}`);
    lines.push(`Advertised tools actual: ${d.actualTools ? d.actualTools.join(", ") : "unknown (could not run local tools/list)"}`);
    lines.push(`Runtime flags: submissions_open=${d.cap === undefined ? "unknown" : String(!!d.cap.submissions_open)}, search_gate_mode=${d.cap?.search_gate_mode || "unknown"}, freshness_crons_configured=${d.cap === undefined ? "unknown" : String(!!d.cap.freshness_crons_configured)}`);
    lines.push(`Global env drift: ${d.warnings.filter((w) => /global\/default/.test(w)).join("; ") || "none"}`);
  }
  for (const w of d.warnings) lines.push(`WARN: ${w}`);
  lines.push(`Next fix: ${d.next}`);
  return lines.join("\n");
}
function selftest() {
  const closed = { submissions_open: false, search_gate_mode: "off", freshness_crons_configured: false };
  let out = render("full", { ACE_TARGET_NAME: "ace-oleg-team0", ACE_TARGET_KIND: "team", ACE_REGISTRY_URL: "https://ace-oleg-team0.ogiberstein.workers.dev", ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_TEST_CAPABILITIES_FIXTURE: "1", ACE_CAPABILITIES_JSON: JSON.stringify(closed), ACE_TOKEN_FILE: "/tmp/missing-token" });
  assert.match(out, /ACE role: submitter/);
  assert.match(out, /submit=configured-but-target-closed/);
  assert.match(out, /SUBMISSIONS_OPEN=0/);
  assert.match(out, /team-shared/);
  assert.doesNotMatch(out, /secret|TOKEN_CONTENT|KEY_CONTENT/);
  out = render("full", { ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_CAPABILITIES_JSON: JSON.stringify(closed), ACE_TOKEN_FILE: "/tmp/missing-token" });
  assert.match(out, /submit=configured-but-target-unknown/);
  out = render("startup", { ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_TOKEN_FILE: "/tmp/missing-token" });
  assert.match(out, /submit=not probed at startup/);
  assert.match(out, /Next fix: If this should use Team ACE, relaunch with explicit ACE_REGISTRY_URL/);
  out = render("full", { ACE_ROLE: "retrieval", ACE_REGISTRY_URL: "https://ace-oleg-team0.ogiberstein.workers.dev" });
  assert.match(out, /global\/default ACE env/);
  out = render("full", { ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_PUBLISH_KEY_FILE: "/tmp/some-key" });
  assert.match(out, /publish-key path set/);
  out = render("full", { ACE_ROLE: "admin", ACE_PROFILE_LAUNCHED: "1", ACE_PUBLISH_KEY_FILE: "/tmp/nonexistent" });
  assert.match(out, /admin profile missing publish key file/);
  out = render("startup", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_REGISTRY_URL: "https://ace-registry.ogiberstein.workers.dev" });
  assert.match(out, /Public ACE/);
  out = render("full", { ACE_ROLE: "${ACE_ROLE}", ACE_REGISTRY_URL: "${ACE_REGISTRY_URL}", ACE_TOKEN_FILE: "${ACE_TOKEN_FILE}", ACE_PUBLISH_KEY_FILE: "${ACE_PUBLISH_KEY_FILE}" });
  assert.doesNotMatch(out, /global\/default ACE env/);
  out = render("full", { ACE_AUTHORING_MODE: "1" });
  assert.match(out, /legacy ACE_AUTHORING_MODE=1 resolved to admin/);
  out = render("full", { ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_ACTUAL_TOOLS_JSON: JSON.stringify(["ace_search"]) });
  assert.match(out, /MCP tool table mismatch/);
  console.log("PASS doctor fixture tests");
}
async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const preflight = process.argv.includes("--submit-preflight");
  const startup = process.argv.includes("--startup-summary");
  if (!startup && !process.env.ACE_CAPABILITIES_JSON && !process.env.ACE_CAPABILITIES_FIXTURE_FILE) {
    const registryUrl = envOrDefault(process.env.ACE_REGISTRY_URL, "https://ace-registry.ogiberstein.workers.dev").replace(/\/$/, "");
    const cap = await fetchCapabilities(registryUrl);
    if (cap) {
      process.env.ACE_CAPABILITIES_JSON = JSON.stringify(cap);
      process.env.ACE_CAPABILITIES_SOURCE = "runtime_fetch";
    }
  }
  if (!startup) {
    try {
      const actual = listActualTools(process.env);
      if (actual) process.env.ACE_ACTUAL_TOOLS_JSON = JSON.stringify(actual);
    } catch {}
  }
  const out = render(startup ? "startup" : "full");
  console.log(out);
  const d = diagnose(process.env, { startup });
  if (preflight) {
    const hardMisconfig = d.role === "retrieval" || !exists(d.token) || d.warnings.length > 0 || (d.cap && d.cap.submissions_open === false);
    if (hardMisconfig) process.exit(2);
  }
}
main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
