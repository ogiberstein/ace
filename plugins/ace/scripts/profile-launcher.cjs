#!/usr/bin/env node
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert/strict");

function usage() {
  console.log(`ACE role/profile launcher

Launch one Claude Code/Codex session against one ACE target+role. This is how you switch between Public ACE and a Team ACE instance today: exit the current agent session and relaunch with the intended profile, then run /ace:doctor first.

Usage:
  node scripts/profile-launcher.cjs --target <name> --kind <public|team> --url <registry-url> --role <retrieval|submitter|admin> --token-file <path> [options] [-- claude]

Required:
  --url <url>              ACE registry URL for this profile
  --role <role>            retrieval, submitter, or admin
  --token-file <path>      consumer Bearer token file for this target

Options:
  --target <name>          display label, e.g. ace-public or ace-oleg-team0
  --kind <public|team>     target kind; if omitted, inferred from --url (Team ACE uses team-shared wording)
  --publish-key-file <p>   required for admin; forbidden for submitter except __ACE_NO_PUBLISH_KEY__ sentinel
  --expose-get <0|1>       retrieval role only; default 0
  --print-env, --dry-run   print non-secret env and exit
  -h, --help               show this help

Examples:
  # Public ACE retrieval profile
  node scripts/profile-launcher.cjs --target ace-public --kind public --url https://ace-registry.ogiberstein.workers.dev --role retrieval --token-file "$HOME/.ace/token" -- claude

  # Team ACE submitter profile; no publish key mounted
  node scripts/profile-launcher.cjs --target ace-oleg-team0 --kind team --url https://ace-oleg-team0.ogiberstein.workers.dev --role submitter --token-file "$HOME/.ace/ace-oleg-team0/claude-code-b/token" --publish-key-file __ACE_NO_PUBLISH_KEY__ -- claude

  # Team ACE admin profile; intentional decision/publish key mounted
  node scripts/profile-launcher.cjs --target ace-oleg-team0 --kind team --url https://ace-oleg-team0.ogiberstein.workers.dev --role admin --token-file "$HOME/.ace/ace-oleg-team0/claude-code-a/token" --publish-key-file "$HOME/.ace/ace-oleg-team0/admin/import_delete_key" -- claude

After launch, run /ace:doctor. If target/role/token/key posture is wrong, stop and relaunch; do not fix by exporting globals in your shell startup files.`);
}
// Flags that are booleans: they never consume the following token and they
// suppress the launch (BUG-15). Everything else is value-taking (SEC-C-10):
// a missing value, or a value that is itself a flag / the `--` terminator,
// is an error naming the offending flag rather than a silent mis-launch.
const BOOLEAN_FLAGS = new Set(["--print-env", "--dry-run"]);
const VALUE_FLAGS = new Set(["--target", "--kind", "--url", "--role", "--token-file", "--publish-key-file", "--expose-get"]);
function parse(argv) {
  const out = { cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--") { out.cmd = argv.slice(i + 1); break; }
    if (!a.startsWith("--")) die(`unexpected argument ${a}; put the command after --`);
    if (!BOOLEAN_FLAGS.has(a) && !VALUE_FLAGS.has(a)) die(`unknown flag ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOLEAN_FLAGS.has(a)) { out[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) die(`${a} requires a value`);
    out[key] = value;
    i++;
  }
  return out;
}
function die(msg) { console.error(`ace profile launch: ${msg}\nRun: node scripts/profile-launcher.cjs --help`); process.exit(2); }
function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}
function checkTransport(url) {
  let parsed;
  try { parsed = new URL(url); } catch { die(`--url is not a valid URL: ${url}`); }
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
    die(`--url must use https:// unless the host is localhost/127.0.0.1/::1 (got ${parsed.protocol}//${parsed.hostname})`);
  }
}
const PRINT_ENV_KEYS = ["ACE_PROFILE_LAUNCHED", "ACE_TARGET_NAME", "ACE_TARGET_KIND", "ACE_REGISTRY_URL", "ACE_ROLE", "ACE_TOKEN_FILE", "ACE_PUBLISH_KEY_FILE", "ACE_EXPOSE_GET", "ACE_SUBMIT_MODE", "ACE_ADMIN_MODE"];
function buildEnv(args, role) {
  const explicit = {
    ACE_PROFILE_LAUNCHED: "1",
    ACE_TARGET_NAME: args.target || "ace-target",
    ACE_REGISTRY_URL: args.url,
    ACE_ROLE: role,
    ACE_TOKEN_FILE: args.tokenFile,
    ACE_EXPOSE_GET: role === "retrieval" ? (args.exposeGet || "0") : "1",
    ACE_SUBMIT_MODE: role === "submitter" || role === "admin" ? "1" : "0",
    ACE_ADMIN_MODE: role === "admin" ? "1" : "0",
  };
  // BUG-16 / SEC-C-11: only stamp ACE_TARGET_KIND when --kind is given. Omitting
  // it leaves the var unset so doctor/mcp-server infer kind from the URL (their
  // single source of truth) instead of the launcher defaulting to "team" and
  // mislabeling a Public ACE profile.
  if (args.kind) explicit.ACE_TARGET_KIND = args.kind;
  if (role === "admin") explicit.ACE_PUBLISH_KEY_FILE = args.publishKeyFile;
  // SEC-C-7: allowlist, not passthrough. Inherit the parent env, then drop every
  // ACE_* var the launcher does not itself set — a leftover ACE_CAPABILITIES_JSON,
  // fixture var, ACE_REVIEWER_CONFIGURED, etc. must not ride invisibly into the
  // child, where ACE_PROFILE_LAUNCHED=1 would suppress the drift warning meant to
  // surface exactly that leakage. Legitimately launcher-set vars are re-applied
  // from `explicit`.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("ACE_") && !Object.prototype.hasOwnProperty.call(explicit, k)) delete env[k];
  }
  return Object.assign(env, explicit);
}
function validateArgs(args) {
  const role = args.role;
  if (!["retrieval", "submitter", "admin"].includes(role)) die("--role must be retrieval, submitter, or admin");
  if (!args.url) die("--url required");
  checkTransport(args.url);
  if (!args.tokenFile) die("--token-file required");
  if (role === "admin" && !args.publishKeyFile) die("admin requires --publish-key-file");
  if (role === "submitter" && args.publishKeyFile && args.publishKeyFile !== "__ACE_NO_PUBLISH_KEY__") die("submitter must not receive --publish-key-file");
  return role;
}
function run() {
  const args = parse(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  const role = validateArgs(args);
  const env = buildEnv(args, role);
  if (args.dryRun || args.printEnv) {
    for (const k of PRINT_ENV_KEYS) {
      if (env[k]) console.log(`${k}=${env[k]}`);
    }
    process.exit(0);
  }
  const cmd = args.cmd.length ? args.cmd : ["claude"];
  // Display-only kind: when --kind was omitted (ACE_TARGET_KIND unset) infer it
  // from the URL for the log line, matching doctor's targetKindOf inference.
  const displayKind = env.ACE_TARGET_KIND || (/ace-registry\.ogiberstein\.workers\.dev/.test(args.url) ? "public" : "team");
  console.error(`Launching ${displayKind} ${env.ACE_TARGET_NAME} as ${role}; token/key contents hidden.`);
  const child = cp.spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, cwd: process.cwd() });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

function selftest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-launcher-selftest-"));
  const shimPath = path.join(tmpDir, "fake-claude.cjs");
  // A fake `claude` that dumps only the ACE_* env it was launched with, so a
  // test can assert exactly which vars crossed into the child process.
  const shimBody =
    'const keys = Object.keys(process.env).filter((k) => k.startsWith("ACE_")).sort();\n' +
    'process.stdout.write("FAKE_CLAUDE_ACE_ENV:" + keys.map((k) => k + "=" + process.env[k]).join("|") + "\\n");\n';
  fs.writeFileSync(shimPath, shimBody);
  // A PATH-resolvable executable named `claude` so a default-command launch
  // (no `-- cmd`) resolves to this fake instead of a real Claude.
  const claudePath = path.join(tmpDir, "claude");
  fs.writeFileSync(claudePath, "#!/usr/bin/env node\n" + shimBody, { mode: 0o755 });
  const pathWithFakeClaude = tmpDir + path.delimiter + (process.env.PATH || "");
  const runLauncher = (argv, extraEnv = {}) =>
    cp.spawnSync(process.execPath, [__filename, ...argv], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  const parseChildEnv = (r) => {
    const line = String(r.stdout || "").split(/\n/).find((l) => l.startsWith("FAKE_CLAUDE_ACE_ENV:")) || "";
    return Object.fromEntries(
      line.replace("FAKE_CLAUDE_ACE_ENV:", "").split("|").filter(Boolean).map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
  };
  const launched = (r) => String(r.stdout || "").includes("FAKE_CLAUDE_ACE_ENV:");
  try {
    // SEC-C-7 — the launcher builds the child env as an allowlist, not a
    // passthrough: an inherited ACE_* var it does not itself set (a leftover
    // ACE_CAPABILITIES_JSON, a fixture var, ACE_REVIEWER_CONFIGURED) must be
    // absent from the child, while the vars it legitimately sets survive.
    {
      const r = runLauncher(
        ["--target", "ace-x", "--kind", "team", "--url", "https://team.example.test", "--role", "submitter", "--token-file", "/tmp/tok", "--publish-key-file", "__ACE_NO_PUBLISH_KEY__", "--", process.execPath, shimPath],
        { ACE_CAPABILITIES_JSON: "STRAYVALUE", ACE_CAPABILITIES_FIXTURE_FILE: "/tmp/stray-fixture", ACE_REVIEWER_CONFIGURED: "1" },
      );
      const childEnv = parseChildEnv(r);
      assert.ok(!("ACE_CAPABILITIES_JSON" in childEnv), "SEC-C-7: ACE_CAPABILITIES_JSON must be absent from the child env");
      assert.ok(!("ACE_CAPABILITIES_FIXTURE_FILE" in childEnv), "SEC-C-7: ACE_CAPABILITIES_FIXTURE_FILE must be absent from the child env");
      assert.ok(!("ACE_REVIEWER_CONFIGURED" in childEnv), "SEC-C-7: inherited ACE_* the launcher does not set must be absent from the child env");
      assert.equal(childEnv.ACE_ROLE, "submitter", "SEC-C-7: launcher-set ACE_ROLE must survive");
      assert.equal(childEnv.ACE_REGISTRY_URL, "https://team.example.test", "SEC-C-7: launcher-set ACE_REGISTRY_URL must survive");
      assert.equal(childEnv.ACE_TOKEN_FILE, "/tmp/tok", "SEC-C-7: launcher-set ACE_TOKEN_FILE must survive");
      assert.equal(childEnv.ACE_TARGET_NAME, "ace-x", "SEC-C-7: launcher-set ACE_TARGET_NAME must survive");
      assert.equal(childEnv.ACE_PROFILE_LAUNCHED, "1", "SEC-C-7: launcher-set ACE_PROFILE_LAUNCHED must survive");
      assert.ok(launched(r), "SEC-C-7: a normal invocation launches the child");
    }
    // BUG-15 / SEC-C-10 — boolean flags do not consume the next arg and suppress launch.
    {
      // (a) A trailing --print-env must print env and NOT fall through to a
      // default `claude` launch (the BUG-15 admin-key foot-gun).
      const r = runLauncher(
        ["--target", "ace-a", "--kind", "team", "--url", "https://team.example.test", "--role", "admin", "--token-file", "/tmp/tok", "--publish-key-file", "/tmp/key", "--print-env"],
        { PATH: pathWithFakeClaude },
      );
      assert.equal(r.status, 0, "BUG-15: trailing --print-env exits 0");
      assert.ok(!launched(r), "BUG-15: trailing --print-env must suppress the launch");
      assert.match(String(r.stdout || ""), /ACE_ROLE=admin/, "BUG-15: --print-env prints the env");

      // (b) A mid-args --dry-run must not swallow the following --publish-key-file.
      const r2 = runLauncher(
        ["--target", "ace-a", "--kind", "team", "--url", "https://team.example.test", "--role", "admin", "--token-file", "/tmp/tok", "--dry-run", "--publish-key-file", "/tmp/key"],
        { PATH: pathWithFakeClaude },
      );
      assert.equal(r2.status, 0, "BUG-15: --dry-run exits 0");
      assert.ok(!launched(r2), "BUG-15: --dry-run must suppress the launch");
      assert.match(String(r2.stdout || ""), /ACE_PUBLISH_KEY_FILE=\/tmp\/key/, "BUG-15: --dry-run did not consume --publish-key-file");

      // (c) SEC-C-10 — a value-taking flag followed by another flag dies naming
      // the offending flag (exit 2), never launching.
      const r3 = runLauncher(
        ["--url", "https://team.example.test", "--token-file", "--role", "admin", "--publish-key-file", "/tmp/key", "--", process.execPath, shimPath],
      );
      assert.equal(r3.status, 2, "SEC-C-10: a value flag with no value exits 2");
      assert.ok(!launched(r3), "SEC-C-10: must not launch");
      assert.match(String(r3.stderr || ""), /--token-file/, "SEC-C-10: error names the offending flag");

      // (d) Value flags with a proper value still work: --token-file X.
      const r4 = runLauncher(
        ["--target", "ace-a", "--kind", "team", "--url", "https://team.example.test", "--role", "submitter", "--token-file", "/tmp/tok", "--publish-key-file", "__ACE_NO_PUBLISH_KEY__", "--print-env"],
        { PATH: pathWithFakeClaude },
      );
      assert.equal(r4.status, 0);
      assert.ok(!launched(r4));
      assert.match(String(r4.stdout || ""), /ACE_TOKEN_FILE=\/tmp\/tok/, "BUG-15: --token-file still consumes its value");

      const typo = runLauncher(
        ["--target", "ace-a", "--kind", "team", "--url", "https://team.example.test", "--role", "admin", "--token-file", "/tmp/tok", "--publish-key-file", "/tmp/key", "--dry-rnu", "yes"],
        { PATH: pathWithFakeClaude },
      );
      assert.equal(typo.status, 2, "unknown/misspelled flags fail closed");
      assert.ok(!launched(typo), "unknown/misspelled flags must not launch");
      assert.match(String(typo.stderr || ""), /unknown flag --dry-rnu/);
      console.log("PASS profile-launcher: boolean flags do not consume the next arg and suppress launch");
    }

    // BUG-16 / SEC-C-11 — omitted --kind defers to URL inference rather than
    // stamping ACE_TARGET_KIND=team, which would mislabel a Public ACE profile.
    {
      const prod = runLauncher(["--target", "ace-public", "--url", "https://ace-registry.ogiberstein.workers.dev", "--role", "retrieval", "--token-file", "/tmp/tok", "--print-env"]);
      assert.equal(prod.status, 0);
      const prodOut = String(prod.stdout || "");
      assert.doesNotMatch(prodOut, /ACE_TARGET_KIND=team/, "SEC-C-11: omitted --kind must not stamp team on a public URL");
      assert.doesNotMatch(prodOut, /ACE_TARGET_KIND=/, "BUG-16: omitted --kind leaves ACE_TARGET_KIND unset for downstream URL inference");

      const team = runLauncher(["--target", "ace-x", "--kind", "team", "--url", "https://team.example.test", "--role", "retrieval", "--token-file", "/tmp/tok", "--print-env"]);
      assert.match(String(team.stdout || ""), /ACE_TARGET_KIND=team/, "explicit --kind is honored");

      // Consequence: doctor infers "public" for the prod URL with no kind set,
      // so there is no Team/Public mismatch warning.
      const doctorEnv = { ...process.env, ACE_ROLE: "retrieval", ACE_PROFILE_LAUNCHED: "1", ACE_REGISTRY_URL: "https://ace-registry.ogiberstein.workers.dev" };
      delete doctorEnv.ACE_TARGET_KIND;
      delete doctorEnv.ACE_PUBLISH_KEY_FILE;
      const doctorOut = cp.spawnSync(process.execPath, [path.join(__dirname, "doctor.cjs"), "--startup-summary"], { env: doctorEnv, encoding: "utf8" });
      assert.doesNotMatch(String(doctorOut.stdout || ""), /Team ACE profile points at Public ACE/, "BUG-16: prod URL with no kind produces no Team/Public mismatch");
      console.log("PASS profile-launcher: omitted --kind defers to URL inference");
    }
    console.log("PASS profile-launcher selftests");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--selftest")) selftest();
else run();
