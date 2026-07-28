#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const assert = require("assert/strict");
const DEFAULT_REGISTRY_URL = "https://ace-registry.ogiberstein.workers.dev";

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
// BUG-21: identical rule to mcp-server.cjs sanitizeTargetName, so the label
// doctor prints matches the target_name every retrieval payload stamps.
function sanitizeTargetName(value) {
  const raw = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw) ? raw : "ace-target-invalid-name";
}
// UX-6: comparison of the local target label against the registry's
// environment slug. Normalize (lowercase, drop a leading "ace-", strip
// non-alphanumerics) and require equality. Substring matching lets stale labels
// such as `ace-friend-kestrel-old` silently agree with `friend-kestrel`.
function normalizeLabel(value) {
  return String(value || "").toLowerCase().replace(/^ace-/, "").replace(/[^a-z0-9]/g, "");
}
function environmentAgrees(localName, serverEnv) {
  const a = normalizeLabel(localName);
  const b = normalizeLabel(serverEnv);
  if (!a || !b) return true;
  return a === b;
}
function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}
function transportIssue(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol === "https:") return null;
  if (isLoopbackHost(parsed.hostname)) return null;
  return `${url} uses ${parsed.protocol.replace(/:$/, "")}:// to a non-loopback host; credentials would be sent in cleartext`;
}
function label(kind) { return kind === "team" ? "Team ACE" : "Public ACE"; }
function visibility(kind) { return kind === "team" ? "team-shared" : "Public ACE"; }
function tokenFile(env) { return envOrDefault(env.ACE_TOKEN_FILE, path.join(os.homedir(), ".ace", "token")); }
function publishKeyFile(env, role) { return role === "admin" ? envOrDefault(env.ACE_PUBLISH_KEY_FILE, path.join(os.homedir(), ".ace", "publish_key")) : envOrDefault(env.ACE_PUBLISH_KEY_FILE, ""); }
function tokenMetadataFile(p) { return `${p}.meta.json`; }
function exists(p) { return !!p && fs.existsSync(p); }
function tokenIssuedOrigin(p) {
  const metadataPath = tokenMetadataFile(p);
  if (!exists(metadataPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    return typeof parsed.origin === "string" ? new URL(parsed.origin).origin : null;
  } catch {
    return null;
  }
}
function modeIssue(p) {
  if (!exists(p)) return null;
  let mode;
  try { mode = fs.statSync(p).mode & 0o777; } catch { return null; }
  const octal = mode.toString(8).padStart(3, "0");
  if ((mode & 0o400) === 0) return `${p} is present but unreadable by owner (mode 0${octal})`;
  if ((mode & 0o077) !== 0) return `${p} is not mode 0600 (found 0${octal})`;
  return null;
}
function capabilities(role, cap, opts = {}) {
  const retrieval = true;
  const publish = role === "admin";
  let submit = role === "submitter" || role === "admin";
  let submitLabel = submit ? "yes" : "no";
  if (submit && cap && cap.submissions_open === false) submitLabel = "configured-but-target-closed";
  if (submit && cap === null) submitLabel = opts.startup ? "not probed at startup" : "configured-but-target-unknown";
  return { retrieval, submit, publish, submitLabel };
}
// SEC-C-1: every parse of file/env content is guarded. On invalid JSON we warn
// with the env var *name* only (never any parsed content, which may bear a
// secret) and treat the value as absent, so doctor never crashes (exit 1) and
// never echoes the content.
function parseJsonGuarded(raw, varName, warnings) {
  try {
    return JSON.parse(raw);
  } catch {
    warnings.push(`${varName} is not valid JSON; ignoring`);
    return undefined;
  }
}
// SEC-C-6: the parse gate must match main()'s fetch-skip gate. main() skips the
// live /v1/capabilities probe whenever ACE_CAPABILITIES_JSON or
// ACE_CAPABILITIES_FIXTURE_FILE is present, so parsing must honor the value on
// the same condition — otherwise an inherited value silently disables the probe
// AND is discarded, leaving intake "unknown" with preflight exiting 0. Honoring
// it keeps the two symmetric; SEC-C-7 (launcher allowlist) plus the global-env
// drift WARN keep a stray value from silently overriding a launched profile.
function parseCapabilities(env, warnings) {
  if (env.ACE_CAPABILITIES_JSON) return parseJsonGuarded(env.ACE_CAPABILITIES_JSON, "ACE_CAPABILITIES_JSON", warnings);
  if (env.ACE_CAPABILITIES_FIXTURE_FILE) {
    let contents;
    try {
      contents = fs.readFileSync(env.ACE_CAPABILITIES_FIXTURE_FILE, "utf8");
    } catch {
      warnings.push("ACE_CAPABILITIES_FIXTURE_FILE could not be read; ignoring");
      return undefined;
    }
    return parseJsonGuarded(contents, "ACE_CAPABILITIES_FIXTURE_FILE", warnings);
  }
  return undefined;
}
function parseActualTools(env, warnings) {
  if (!env.ACE_ACTUAL_TOOLS_JSON) return undefined;
  return parseJsonGuarded(env.ACE_ACTUAL_TOOLS_JSON, "ACE_ACTUAL_TOOLS_JSON", warnings);
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
  const registryUrl = envOrDefault(env.ACE_REGISTRY_URL, DEFAULT_REGISTRY_URL).replace(/\/$/, "");
  const targetName = sanitizeTargetName(envOrDefault(env.ACE_TARGET_NAME, /ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl) ? "ace-public" : "ace-target"));
  const kind = targetKindOf(env, registryUrl);
  const token = tokenFile(env);
  const pub = publishKeyFile(env, role);
  const tokenUsesBuiltInDefault = !envIsSet(env, "ACE_TOKEN_FILE");
  const publishKeyUsesBuiltInDefault = role === "admin" && !envIsSet(env, "ACE_PUBLISH_KEY_FILE");
  const warnings = [];
  const cap = parseCapabilities(env, warnings);
  // SEC-C-5: a capabilities payload only counts as a decision-grade signal when
  // it is an object carrying a boolean submissions_open. Anything else (missing,
  // {}, non-object, non-boolean) is treated as "unknown" uniformly across the
  // submit label, the intake line, and the preflight exit code, so the printed
  // claim and the exit code never disagree.
  const capValid = cap !== undefined && cap !== null && typeof cap === "object" && typeof cap.submissions_open === "boolean";
  const caps = capabilities(role, capValid ? cap : null, { startup: opts.startup === true });
  const actualTools = parseActualTools(env, warnings);
  const issuedOrigin = tokenIssuedOrigin(token);
  const targetOrigin = (() => { try { return new URL(registryUrl).origin; } catch { return null; } })();
  if (issuedOrigin && targetOrigin && issuedOrigin !== targetOrigin) {
    warnings.push(`token file was issued for ${issuedOrigin}, but this profile targets ${targetOrigin}`);
  }
  const defaultOrigin = new URL(DEFAULT_REGISTRY_URL).origin;
  const nonDefaultTarget = kind === "team" || (targetOrigin && targetOrigin !== defaultOrigin);
  if (nonDefaultTarget && (tokenUsesBuiltInDefault || publishKeyUsesBuiltInDefault)) {
    warnings.push("default global credential path used with a non-default target; likely miswire");
  }
  const tokenModeIssue = modeIssue(token);
  if (tokenModeIssue) warnings.push(tokenModeIssue);
  const pubModeIssue = modeIssue(pub);
  if (pubModeIssue) warnings.push(pubModeIssue);
  const transportWarning = transportIssue(registryUrl);
  if (transportWarning) warnings.push(transportWarning);
  if (!explicitRegistryUrl) warnings.push("ACE_REGISTRY_URL unset; using built-in Public ACE default. If this session should use Team ACE, this is a likely miswire.");
  if (kind === "team" && /ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl)) warnings.push("Team ACE profile points at Public ACE production URL");
  if (kind === "public" && !/ace-registry\.ogiberstein\.workers\.dev/.test(registryUrl)) warnings.push("Public ACE profile points at a non-production/isolated URL");
  const serverEnvironment = cap && typeof cap === "object" && typeof cap.environment === "string" ? cap.environment : null;
  if (serverEnvironment && !environmentAgrees(targetName, serverEnvironment)) {
    warnings.push(`target label "${targetName}" does not match the registry environment "${serverEnvironment}"; the target name is a local label — confirm the URL/registry origin is the intended target`);
  }
  const driftVars = ["ACE_REGISTRY_URL", "ACE_TOKEN_FILE", "ACE_PUBLISH_KEY_FILE", "ACE_ROLE", "ACE_AUTHORING_MODE", "ACE_SUBMIT_MODE", "ACE_ADMIN_MODE", "ACE_CAPABILITIES_JSON", "ACE_CAPABILITIES_FIXTURE_FILE"].filter((k) => envIsSet(env, k) && !truthy(env.ACE_PROFILE_LAUNCHED));
  if (driftVars.length) warnings.push(`global/default ACE env without ACE_PROFILE_LAUNCHED=1: ${driftVars.join(", ")}`);
  if (legacyAuthoringAdmin(env)) warnings.push("legacy ACE_AUTHORING_MODE=1 resolved to admin; relaunch with ACE_ROLE=admin instead");
  if ((role === "retrieval" || role === "submitter") && pub && pub !== "__ACE_NO_PUBLISH_KEY__") warnings.push(`${role} profile has a publish-key path set; fail closed and relaunch without it`);
  const expected = expectedTools(role, env);
  if (actualTools && JSON.stringify(actualTools) !== JSON.stringify(expected)) warnings.push(`MCP tool table mismatch: expected ${expected.join(",")} actual ${actualTools.join(",")}`);
  if (role === "admin" && !exists(pub)) warnings.push("admin profile missing publish key file");
  const intake = !capValid ? "unknown (target does not expose/provide capability status yet; until /v1/capabilities is deployed on this target, closed-intake protection is enforced by the registry /v1/submissions server-side 503, not by local preflight)" : (cap.submissions_open ? "open" : "closed — SUBMISSIONS_OPEN=0 on target; local preflight stops before submit while /v1/capabilities is live");
  let next = "No action; profile healthy";
  if (warnings.some((w) => /publish-key path/.test(w))) next = "Relaunch without ACE_PUBLISH_KEY_FILE in retrieval/submitter profile";
  else if (warnings.some((w) => /missing publish key/.test(w))) next = "Relaunch admin profile with ACE_ADMIN_MODE=1 and ACE_PUBLISH_KEY_FILE set";
  else if (role === "submitter" && capValid && cap.submissions_open === false) next = "Ask operator to open Team ACE submissions; no local fix";
  else if (driftVars.length) next = "Exit and relaunch via an ACE role profile";
  else if (!explicitRegistryUrl && (kind === "team" || role === "submitter" || role === "admin")) next = "If this should use Team ACE, relaunch with explicit ACE_REGISTRY_URL; otherwise this Public ACE default warning is informational";
  else if (!exists(token)) next = "Run /ace:login in this profile";
  return { role, registryUrl, explicitRegistryUrl, targetName, kind, token, pub, tokenUsesBuiltInDefault, publishKeyUsesBuiltInDefault, cap, capValid, caps, warnings, intake, next, tools: expected, actualTools };
}
// UX-16a: build the exact profile-launcher one-liner that relaunches THIS
// target under a given role, so a wrong-profile session recovers by copy/paste
// instead of terminal archeology.
function relaunchCommand(targetRole, d) {
  const launcher = path.join(__dirname, "profile-launcher.cjs");
  const targetRoot = d.kind === "team" ? path.join(os.homedir(), ".ace", d.targetName) : path.join(os.homedir(), ".ace");
  const targetToken = targetRole === "admin" && d.kind === "team" ? path.join(targetRoot, "claude-code-a", "token") : path.join(targetRoot, "token");
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const parts = ["node", launcher, "--target", d.targetName, "--kind", d.kind, "--url", d.registryUrl, "--role", targetRole, "--token-file", targetToken];
  if (targetRole === "admin") {
    const adminKey = d.kind === "team" ? path.join(targetRoot, "admin", "import_delete_key") : path.join(targetRoot, "publish_key");
    parts.push("--publish-key-file", adminKey);
  }
  parts.push("--", "claude");
  return parts.map(shellQuote).join(" ");
}
function render(mode, env = process.env) {
  const d = diagnose(env, { startup: mode === "startup" });
  const lines = [];
  lines.push(`ACE target: ${label(d.kind)} ${d.targetName} (${d.registryUrl})`);
  lines.push(`ACE role: ${d.role}`);
  lines.push(`Capabilities: retrieval=yes, submit=${d.caps.submitLabel}, publish=${d.caps.publish ? "yes" : "no"}`);
  lines.push(`Retrieval wiring: agent-initiated via SessionStart → ${d.targetName} (${d.kind})${d.explicitRegistryUrl ? "" : " [built-in default URL]"}`);
  lines.push(`Token file: ${d.token ? `configured ${exists(d.token) ? "+ present" : "+ missing"} (${d.token}; contents hidden)${d.tokenUsesBuiltInDefault ? " [built-in default path]" : ""}` : "absent"}`);
  lines.push(`Publish key: ${d.pub ? `configured ${exists(d.pub) ? "+ present" : "+ missing"} (${d.pub}; contents hidden)${d.publishKeyUsesBuiltInDefault ? " [built-in default path]" : ""}` : (d.role === "admin" ? "missing" : "absent")}`);
  lines.push(`Submission intake: ${mode === "startup" && !d.capValid ? "not probed at startup — run /ace:doctor for live state" : d.intake}`);
  lines.push(`Visibility language: ${visibility(d.kind)}${d.kind === "team" ? " inside this Team ACE instance; not Public ACE" : " global corpus"}`);
  if (mode !== "startup") {
    lines.push(`Advertised tools expected: ${d.tools.join(", ")}`);
    lines.push(`Advertised tools actual: ${d.actualTools ? d.actualTools.join(", ") : "unknown (could not run local tools/list)"}`);
    lines.push(`Runtime flags: submissions_open=${!d.capValid ? "unknown" : String(!!d.cap.submissions_open)}, search_gate_mode=${(d.capValid && d.cap.search_gate_mode) || "unknown"}, freshness_crons_configured=${!d.capValid ? "unknown" : String(!!d.cap.freshness_crons_configured)}`);
    lines.push(`Global env drift: ${d.warnings.filter((w) => /global\/default/.test(w)).join("; ") || "none"}`);
    if (d.role !== "admin") {
      lines.push(`Admin tools: not exposed in this ${d.role} profile — /ace:review-queue and other admin commands are wrong-profile here.`);
      lines.push(`To run admin commands on this target, exit and relaunch as admin:`);
      lines.push(`  ${relaunchCommand("admin", d)}`);
    }
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
  // SEC-C-6: a capabilities value present in env is honored even without the
  // fixture flag (symmetric with main()'s fetch-skip), so a closed payload reads
  // "closed" here rather than the old asymmetric "unknown".
  out = render("full", { ACE_ROLE: "submitter", ACE_PROFILE_LAUNCHED: "1", ACE_CAPABILITIES_JSON: JSON.stringify(closed), ACE_TOKEN_FILE: "/tmp/missing-token" });
  assert.match(out, /submit=configured-but-target-closed/);
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
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-mode-"));
    const tokenPath = path.join(tmpDir, "token");
    fs.writeFileSync(tokenPath, "fixture-token\n");
    try {
      fs.chmodSync(tokenPath, 0o644);
      out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TOKEN_FILE: tokenPath });
      assert.match(out, /WARN: .*token.*is not mode 0600 \(found 0644\)/);
      const preflightEnv = {
        ...process.env,
        ACE_ROLE: "submitter",
        ACE_PROFILE_LAUNCHED: "1",
        ACE_REGISTRY_URL: "https://ace-registry.ogiberstein.workers.dev",
        ACE_TOKEN_FILE: tokenPath,
        // Hermetic: skip main()'s live /v1/capabilities fetch; parseCapabilities
        // still treats this as unset since neither fixture-gate flag is set.
        ACE_CAPABILITIES_JSON: "{}",
      };
      delete preflightEnv.ACE_PUBLISH_KEY_FILE;
      delete preflightEnv.ACE_CAPABILITIES_FIXTURE_FILE;
      const preflight644 = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: preflightEnv, encoding: "utf8" });
      assert.equal(preflight644.status, 2);

      fs.chmodSync(tokenPath, 0o600);
      const preflight600 = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: preflightEnv, encoding: "utf8" });
      assert.equal(preflight600.status, 0);

      fs.chmodSync(tokenPath, 0o600);
      out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TOKEN_FILE: tokenPath });
      assert.doesNotMatch(out, /not mode 0600/);
      assert.doesNotMatch(out, /present but unreadable/);

      fs.chmodSync(tokenPath, 0o000);
      out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TOKEN_FILE: tokenPath });
      assert.match(out, /WARN: .*token.*is present but unreadable by owner \(mode 0000\)/);
    } finally {
      fs.chmodSync(tokenPath, 0o600);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_REGISTRY_URL: "http://ace-friend-x.workers.dev" });
  assert.match(out, /WARN: .*http:\/\/ace-friend-x\.workers\.dev uses http:\/\/ to a non-loopback host/);
  out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_REGISTRY_URL: "http://127.0.0.1:8787" });
  assert.doesNotMatch(out, /non-loopback host/);
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-origin-"));
    const tokenPath = path.join(tmpDir, "token");
    fs.writeFileSync(tokenPath, "fixture-token\n", { mode: 0o600 });
    fs.writeFileSync(tokenMetadataFile(tokenPath), `${JSON.stringify({ origin: "https://ace-oleg-team0.example.test" })}\n`, { mode: 0o600 });
    try {
      const baseEnv = {
        ...process.env,
        ACE_ROLE: "submitter",
        ACE_TARGET_KIND: "team",
        ACE_PROFILE_LAUNCHED: "1",
        ACE_TOKEN_FILE: tokenPath,
        ACE_CAPABILITIES_JSON: "{}",
      };
      delete baseEnv.ACE_PUBLISH_KEY_FILE;
      delete baseEnv.ACE_CAPABILITIES_FIXTURE_FILE;
      const mismatchEnv = { ...baseEnv, ACE_REGISTRY_URL: "https://other-team.example.test" };
      out = render("full", mismatchEnv);
      assert.match(out, /WARN: token file was issued for https:\/\/ace-oleg-team0\.example\.test, but this profile targets https:\/\/other-team\.example\.test/);
      const mismatch = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: mismatchEnv, encoding: "utf8" });
      assert.equal(mismatch.status, 2);

      const matchedEnv = { ...baseEnv, ACE_REGISTRY_URL: "https://ace-oleg-team0.example.test/path" };
      out = render("full", matchedEnv);
      assert.doesNotMatch(out, /token file was issued for/);
      const matched = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: matchedEnv, encoding: "utf8" });
      assert.equal(matched.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-default-path-"));
    const tokenPath = path.join(tmpDir, "token");
    fs.writeFileSync(tokenPath, "fixture-token\n", { mode: 0o600 });
    try {
      const teamDefaultEnv = {
        ...process.env,
        ACE_REGISTRY_URL: "https://team.example.test",
        ACE_TARGET_KIND: "team",
        ACE_ROLE: "submitter",
        ACE_PROFILE_LAUNCHED: "1",
        ACE_CAPABILITIES_JSON: "{}",
      };
      delete teamDefaultEnv.ACE_TOKEN_FILE;
      delete teamDefaultEnv.ACE_PUBLISH_KEY_FILE;
      delete teamDefaultEnv.ACE_CAPABILITIES_FIXTURE_FILE;
      out = render("full", teamDefaultEnv);
      assert.match(out, /Token file: .+ \[built-in default path\]/);
      assert.match(out, /WARN: default global credential path used with a non-default target; likely miswire/);
      const defaultPreflight = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: teamDefaultEnv, encoding: "utf8" });
      assert.equal(defaultPreflight.status, 2);

      const explicitTeamEnv = { ...teamDefaultEnv, ACE_TOKEN_FILE: tokenPath };
      out = render("full", explicitTeamEnv);
      assert.doesNotMatch(out, /default global credential path used with a non-default target/);

      const publicDefaultEnv = { ...teamDefaultEnv, ACE_REGISTRY_URL: DEFAULT_REGISTRY_URL, ACE_TARGET_KIND: "public" };
      out = render("full", publicDefaultEnv);
      assert.doesNotMatch(out, /default global credential path used with a non-default target/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  {
    // SEC-C-1 — every JSON.parse of file/env content is guarded: doctor must
    // never crash (exit 1) nor echo the parsed content; a WARN names only the
    // offending env var. Cover all three parse sites.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-secc1-"));
    const badFixtureFile = path.join(tmpDir, "bad-capabilities.json");
    fs.writeFileSync(badFixtureFile, "ZZSECRETZZ this is not json\n");
    try {
      // ACE_CAPABILITIES_JSON and ACE_CAPABILITIES_FIXTURE_FILE crash main() at
      // process level today; assert exit is 0 or 2 (never 1) and no content leak.
      const subprocessCases = [
        { name: "ACE_CAPABILITIES_JSON", env: { ACE_TEST_CAPABILITIES_FIXTURE: "1", ACE_CAPABILITIES_JSON: "ZZSECRETZZ}}not-json" } },
        { name: "ACE_CAPABILITIES_FIXTURE_FILE", env: { ACE_TEST_CAPABILITIES_FIXTURE: "1", ACE_CAPABILITIES_FIXTURE_FILE: badFixtureFile } },
      ];
      for (const c of subprocessCases) {
        const env = { ...process.env, ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_REGISTRY_URL: "https://ace-registry.ogiberstein.workers.dev", ...c.env };
        delete env.ACE_PUBLISH_KEY_FILE;
        const r = cp.spawnSync(process.execPath, [__filename], { env, encoding: "utf8" });
        const combined = String(r.stdout || "") + String(r.stderr || "");
        assert.ok(r.status === 0 || r.status === 2, `SEC-C-1 ${c.name}: exit ${r.status} must be 0 or 2, never 1`);
        assert.doesNotMatch(combined, /ZZSECRETZZ/, `SEC-C-1 ${c.name}: parsed content must never leak`);
        assert.match(combined, new RegExp(`WARN:\\s*${c.name} is not valid JSON`), `SEC-C-1 ${c.name}: WARN names the var only`);
      }
      // ACE_ACTUAL_TOOLS_JSON is overwritten by a successful live tools/list in
      // main(); exercise the guard at the diagnose/render level so it is proven
      // not to throw and not to leak.
      const actualOut = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_ACTUAL_TOOLS_JSON: "ZZSECRETZZ}}not-json" });
      assert.doesNotMatch(actualOut, /ZZSECRETZZ/, "SEC-C-1 ACE_ACTUAL_TOOLS_JSON: content must never leak");
      assert.match(actualOut, /WARN:\s*ACE_ACTUAL_TOOLS_JSON is not valid JSON/, "SEC-C-1 ACE_ACTUAL_TOOLS_JSON: WARN names the var only");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  {
    // SEC-C-5 — a shape-invalid capabilities payload ({} or a non-boolean
    // submissions_open) must read "unknown" consistently across the submit
    // label, the intake line, and the preflight exit code (no "closed …
    // preflight stops" claim while the preflight proceeds). A real closed
    // payload must still read "closed" and exit 2.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-secc5-"));
    const tokenPath = path.join(tmpDir, "token");
    fs.writeFileSync(tokenPath, "fixture-token\n", { mode: 0o600 });
    try {
      const baseEnv = {
        ...process.env,
        ACE_ROLE: "submitter",
        ACE_TARGET_KIND: "team",
        ACE_REGISTRY_URL: "https://team.example.test",
        ACE_PROFILE_LAUNCHED: "1",
        ACE_TOKEN_FILE: tokenPath,
        ACE_TEST_CAPABILITIES_FIXTURE: "1",
      };
      delete baseEnv.ACE_PUBLISH_KEY_FILE;
      delete baseEnv.ACE_CAPABILITIES_FIXTURE_FILE;

      const emptyEnv = { ...baseEnv, ACE_CAPABILITIES_JSON: "{}" };
      out = render("full", emptyEnv);
      assert.match(out, /submit=configured-but-target-unknown/);
      assert.match(out, /Submission intake: unknown/);
      assert.doesNotMatch(out, /Submission intake: closed/);
      const emptyPreflight = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: emptyEnv, encoding: "utf8" });
      assert.equal(emptyPreflight.status, 0);

      const nonBoolEnv = { ...baseEnv, ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: "yes" }) };
      out = render("full", nonBoolEnv);
      assert.match(out, /submit=configured-but-target-unknown/);
      assert.match(out, /Submission intake: unknown/);

      const closedEnv = { ...baseEnv, ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: false }) };
      out = render("full", closedEnv);
      assert.match(out, /submit=configured-but-target-closed/);
      assert.match(out, /Submission intake: closed/);
      const closedPreflight = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: closedEnv, encoding: "utf8" });
      assert.equal(closedPreflight.status, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  {
    // SEC-C-6 — the fetch-skip gate and the parse-honor gate are symmetric: an
    // ACE_CAPABILITIES_JSON present in the environment is honored (and also
    // suppresses the live fetch), so doctor never reports "unknown" and exits 0
    // while a value is present. No ACE_TEST_CAPABILITIES_FIXTURE flag is set
    // here — that asymmetry was the bug.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-doctor-secc6-"));
    const tokenPath = path.join(tmpDir, "token");
    fs.writeFileSync(tokenPath, "fixture-token\n", { mode: 0o600 });
    try {
      const baseEnv = {
        ...process.env,
        ACE_ROLE: "submitter",
        ACE_TARGET_KIND: "team",
        ACE_REGISTRY_URL: "https://team.example.test",
        ACE_PROFILE_LAUNCHED: "1",
        ACE_TOKEN_FILE: tokenPath,
      };
      delete baseEnv.ACE_PUBLISH_KEY_FILE;
      delete baseEnv.ACE_CAPABILITIES_FIXTURE_FILE;
      delete baseEnv.ACE_TEST_CAPABILITIES_FIXTURE;
      delete baseEnv.ACE_CAPABILITIES_SOURCE;

      const inheritedClosed = { ...baseEnv, ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: false }) };
      out = render("full", inheritedClosed);
      assert.match(out, /Submission intake: closed/);
      const closedPreflight = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: inheritedClosed, encoding: "utf8" });
      assert.equal(closedPreflight.status, 2);

      const inheritedOpen = { ...baseEnv, ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: true }) };
      out = render("full", inheritedOpen);
      assert.match(out, /Submission intake: open/);
      const openPreflight = cp.spawnSync(process.execPath, [__filename, "--submit-preflight"], { env: inheritedOpen, encoding: "utf8" });
      assert.equal(openPreflight.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  {
    // BUG-21 — doctor applies the same sanitizeTargetName as mcp-server, so an
    // invalid ACE_TARGET_NAME renders the shared "ace-target-invalid-name"
    // sentinel (the value every retrieval payload stamps) rather than the raw
    // label — the two provenance surfaces agree in exactly the misconfiguration
    // the cross-check exists for.
    out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "Oleg's Team 0", ACE_REGISTRY_URL: "https://team.example.test" });
    assert.match(out, /ACE target: .* ace-target-invalid-name /);
    assert.doesNotMatch(out, /Oleg's Team 0/);
    console.log("PASS doctor: target name parity holds under an invalid ACE_TARGET_NAME");
  }
  {
    // UX-6 — doctor warns when the registry's environment slug disagrees with
    // the sanitized local target label (a mislabeled profile is otherwise
    // decorative: it passes doctor and stamps a wrong-but-healthy name).
    out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "ace-otherteam", ACE_REGISTRY_URL: "https://ace-friend-kestrel.example.test", ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: true, environment: "friend-kestrel", target_kind: "team" }) });
    assert.match(out, /WARN: target label "ace-otherteam" does not match the registry environment "friend-kestrel"/);
    // A label that corresponds to the environment slug does not warn.
    out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "ace-oleg-team0", ACE_REGISTRY_URL: "https://ace-oleg-team0.example.test", ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: true, environment: "oleg-team0", target_kind: "team" }) });
    assert.doesNotMatch(out, /does not match the registry environment/);
    // A stale suffix is a mismatch, not an acceptable partial match.
    out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "ace-friend-kestrel-old", ACE_REGISTRY_URL: "https://ace-friend-kestrel.example.test", ACE_CAPABILITIES_JSON: JSON.stringify({ submissions_open: true, environment: "friend-kestrel", target_kind: "team" }) });
    assert.match(out, /does not match the registry environment/);
    console.log("PASS doctor: target label vs server environment cross-check (UX-6)");
  }
  {
    // UX-16a — a non-admin profile names the admin-tools-absent (wrong-profile)
    // condition and prints the exact copy/paste relaunch command for THIS target,
    // so a failed admin command recovers with a one-liner instead of archeology.
    out = render("full", { ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "ace-oleg-team0", ACE_TARGET_KIND: "team", ACE_REGISTRY_URL: "https://ace-oleg-team0.example.test", ACE_TOKEN_FILE: "/tmp/public-token" });
    assert.match(out, /Admin tools: not exposed/);
    assert.match(out, /profile-launcher\.cjs'.*'--role' 'admin'/);
    assert.match(out, /'--url' 'https:\/\/ace-oleg-team0\.example\.test'/);
    assert.match(out, /--publish-key-file/);
    assert.match(out, /\.ace\/ace-oleg-team0\/claude-code-a\/token/);
    assert.match(out, /\.ace\/ace-oleg-team0\/admin\/import_delete_key/);
    assert.doesNotMatch(out, /--token-file \/tmp\/public-token/);
    // An admin profile does not print the wrong-profile relaunch breadcrumb.
    out = render("full", { ACE_ROLE: "admin", ACE_PROFILE_LAUNCHED: "1", ACE_TARGET_NAME: "ace-oleg-team0", ACE_TARGET_KIND: "team", ACE_REGISTRY_URL: "https://ace-oleg-team0.example.test", ACE_TOKEN_FILE: "/tmp/tok", ACE_PUBLISH_KEY_FILE: "/tmp/key" });
    assert.doesNotMatch(out, /Admin tools: not exposed/);
    console.log("PASS doctor: wrong-profile admin relaunch command (UX-16a)");
  }
  console.log("PASS doctor fixture tests");
}
async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const preflight = process.argv.includes("--submit-preflight");
  const startup = process.argv.includes("--startup-summary");
  if (!startup && !process.env.ACE_CAPABILITIES_JSON && !process.env.ACE_CAPABILITIES_FIXTURE_FILE) {
    const registryUrl = envOrDefault(process.env.ACE_REGISTRY_URL, DEFAULT_REGISTRY_URL).replace(/\/$/, "");
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
    const hardMisconfig = d.role === "retrieval" || !exists(d.token) || d.warnings.length > 0 || (d.capValid && d.cap.submissions_open === false);
    if (hardMisconfig) process.exit(2);
  }
}
main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
