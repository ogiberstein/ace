#!/usr/bin/env node
// Admin-only Team ACE member invitation helper.
// Reads the admin key from ACE_PUBLISH_KEY_FILE and never prints key material.

const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const TARGET_RE = /^ace-[a-z0-9][a-z0-9._-]*$/;
const NOTE_RE = /^[\x20-\x7e]*$/;
const HOME_RE = /^\/[a-zA-Z0-9._/-]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const SETTINGS_START = "--- BEGIN COLLEAGUE SETTINGS JSON ---";
const SETTINGS_END = "--- END COLLEAGUE SETTINGS JSON ---";
const MESSAGE_START = "--- BEGIN ONBOARDING MESSAGE ---";
const MESSAGE_END = "--- END ONBOARDING MESSAGE ---";

function usage() {
  process.stdout.write(`ACE Team member invite helper\n\nUsage:\n  invite-member.cjs <github-login> --home <absolute-path> --resolve-only [--note <text>]\n  invite-member.cjs <github-login> --home <absolute-path> --confirmed [--note <text>]\n  invite-member.cjs --list\n`);
}

function die(message, code = 1) {
  process.stderr.write(`ACE invite error: ${message}\n`);
  process.exit(code);
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) die(`${flag} requires a value`, 2);
  return argv[index];
}

function parseArgs(argv) {
  const opts = { login: null, note: null, home: null, list: false, resolveOnly: false, confirmed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--list") {
      opts.list = true;
    } else if (arg === "--resolve-only") {
      opts.resolveOnly = true;
    } else if (arg === "--confirmed") {
      opts.confirmed = true;
    } else if (arg === "--note") {
      opts.note = requireValue(argv, ++i, arg);
    } else if (arg === "--home") {
      opts.home = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--")) {
      die(`unknown argument: ${arg}`, 2);
    } else if (opts.login === null) {
      opts.login = arg;
    } else {
      die("only one GitHub login may be provided", 2);
    }
  }
  return opts;
}

function validateHome(home) {
  if (!home) die("--home is required; ask your colleague: echo $HOME", 2);
  if (!HOME_RE.test(home) || home === "/" || home.endsWith("/") || home.includes("//") || home.split("/").some((part) => part === "." || part === "..")) {
    die("--home must be an absolute path using only letters, numbers, dot, underscore, slash, or hyphen", 2);
  }
}

function validateInputs(opts, env) {
  if (opts.list) {
    if (opts.login || opts.note !== null || opts.home || opts.resolveOnly || opts.confirmed) {
      die("--list cannot be combined with invite arguments", 2);
    }
  } else {
    if (!opts.login) die("GitHub login is required", 2);
    if (!LOGIN_RE.test(opts.login)) die(`invalid GitHub login; login=${safeLogin(opts.login)}`, 2);
    validateHome(opts.home);
    if (opts.note !== null && (!NOTE_RE.test(opts.note) || /[\x22\x27`]/.test(opts.note))) {
      die(`note must be printable ASCII without quotes or backticks; login=${opts.login}`, 2);
    }
    if (opts.resolveOnly === opts.confirmed) {
      die(`choose exactly one of --resolve-only or --confirmed; login=${opts.login}`, 2);
    }
  }

  if (!env.ACE_REGISTRY_URL) die("ACE_REGISTRY_URL is unset; run this from your admin folder", 2);
  validateRegistryUrl(env.ACE_REGISTRY_URL);
  if (env.ACE_TARGET_KIND !== "team") die("ACE_TARGET_KIND must be team; run this from the intended Team ACE admin folder", 2);
  if (!TARGET_RE.test(env.ACE_TARGET_NAME || "")) die("ACE_TARGET_NAME is invalid; expected ace-<canonical-slug>", 2);
}

function safeLogin(value) {
  return LOGIN_RE.test(String(value || "")) ? String(value) : "invalid";
}

function validateRegistryUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    die("ACE_REGISTRY_URL must be a valid http(s) URL", 2);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    die("ACE_REGISTRY_URL must be a valid http(s) URL", 2);
  }
}

function readAdminKey(env) {
  const keyFile = env.ACE_PUBLISH_KEY_FILE;
  if (!keyFile) {
    die("ACE_PUBLISH_KEY_FILE is unset; run this from your admin folder (`cd ~/ace-admin-<slug> && claude`)", 2);
  }
  let raw;
  try {
    raw = fs.readFileSync(keyFile, "utf8");
  } catch {
    die("ACE_PUBLISH_KEY_FILE is missing or unreadable; run this from your admin folder (`cd ~/ace-admin-<slug> && claude`)", 2);
  }
  const key = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^[\x21-\x7e]+$/.test(key)) {
    die("credential file is not a single-line token; refusing to send", 2);
  }
  return key;
}

function timeoutMs(env) {
  const value = Number(env.ACE_INVITE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30_000) : DEFAULT_TIMEOUT_MS;
}

async function request(url, init, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { response, body };
  } catch {
    return { timeout: true };
  } finally {
    clearTimeout(timer);
  }
}

function registryBase(env) {
  return env.ACE_REGISTRY_URL.replace(/\/+$/, "");
}

async function requireTeamCapabilities(env) {
  const result = await request(`${registryBase(env)}/v1/capabilities`, { headers: { Accept: "application/json" } }, env);
  if (result.timeout) die("capabilities check failed; check the Team ACE URL and try again");
  if (!result.response.ok || !result.body || typeof result.body !== "object") {
    die(`capabilities check failed; status=${result.response.status}; check the Team ACE URL and try again`);
  }
  if (result.body.target_kind !== "team" || result.body.target_kind !== env.ACE_TARGET_KIND) {
    die("capabilities target is not the intended team plane; stop and run /ace:doctor");
  }
}

function githubFixture(env) {
  if (!env.ACE_INVITE_GITHUB_FIXTURE_JSON) return null;
  try {
    return JSON.parse(env.ACE_INVITE_GITHUB_FIXTURE_JSON);
  } catch {
    die("GitHub fixture is invalid; selftest cannot continue");
  }
}

async function resolveGithubProfile(login, env) {
  const fixture = githubFixture(env);
  let status;
  let body;
  if (fixture) {
    status = Number(fixture.status || 200);
    body = fixture.body || fixture;
  } else {
    const result = await request(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ace-invite-member" },
    }, env);
    if (result.timeout) die(`GitHub lookup timed out; login=${login}; try again`);
    status = result.response.status;
    body = result.body;
  }

  if (status === 404) die(`GitHub login was not found; login=${login}; check the spelling`);
  if (status === 403 || status === 429) die(`GitHub lookup was rate-limited; login=${login}; status=${status}; try again later`);
  if (status < 200 || status >= 300) die(`GitHub lookup failed; login=${login}; status=${status}; try again`);
  if (!body || !Number.isSafeInteger(body.id) || body.id <= 0 || !LOGIN_RE.test(body.login || "")) {
    die(`GitHub lookup returned an invalid profile; login=${login}; try again`);
  }
  const name = body.name === null || body.name === undefined ? "(not set)" : String(body.name);
  if (!/^[\x20-\x7e]{1,100}$/.test(name)) die(`GitHub lookup returned an invalid display name; login=${login}`);
  let profileUrl;
  try {
    profileUrl = new URL(String(body.html_url));
  } catch {
    die(`GitHub lookup returned an invalid profile URL; login=${login}`);
  }
  if (profileUrl.protocol !== "https:" || profileUrl.hostname !== "github.com" || profileUrl.username || profileUrl.password) {
    die(`GitHub lookup returned an invalid profile URL; login=${login}`);
  }
  return { login: body.login, id: body.id, name, url: profileUrl.href };
}

function printResolvedProfile(profile) {
  process.stderr.write(`Resolved GitHub profile\nlogin: ${profile.login}\nid: ${profile.id}\ndisplay name: ${profile.name}\nprofile URL: ${profile.url}\n`);
}

function createArtifacts(opts, env, profile) {
  const targetName = env.ACE_TARGET_NAME;
  const slug = targetName.slice(4);
  const settings = {
    env: {
      ACE_REGISTRY_URL: registryBase(env),
      ACE_TARGET_NAME: targetName,
      ACE_TARGET_KIND: "team",
      ACE_ROLE: "submitter",
      ACE_TOKEN_FILE: `${opts.home}/.ace/${slug}/claude-code-submitter/token`,
      ACE_PROFILE_LAUNCHED: "1",
    },
  };
  const settingsJson = JSON.stringify(settings, null, 2);
  JSON.parse(settingsJson);

  const message = [
    "Paste this whole terminal block:",
    "claude plugin update ace",
    "mkdir -p ~/team-ace/.claude",
    "cat > ~/team-ace/.claude/settings.json <<'ACE_SETTINGS_EOF'",
    settingsJson,
    "ACE_SETTINGS_EOF",
    "cd ~/team-ace && claude",
    "This created a `team-ace` folder in your home directory — that's your team workspace: start Claude from there (`cd ~/team-ace && claude`) whenever you want team ACE; sessions started elsewhere use public ACE.",
    "",
    "Then, inside Claude Code:",
    "/ace:login",
    "/ace:doctor",
    "",
    `The doctor result must say Team ACE ${targetName}, submitter, and profile healthy.`,
    "If it says Public ACE, stop and tell me.",
  ].join("\n");

  return { settingsJson, message, targetName, profile };
}

async function postMember(opts, env, key, profile) {
  const result = await request(`${registryBase(env)}/v1/admin/members`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ github_user_id: profile.id, github_login: profile.login, note: opts.note }),
  }, env);
  if (result.timeout) die(`registry invite timed out; login=${profile.login}; retry the confirmed command`);
  const status = result.response.status;
  if (status === 401 || status === 403) die(`registry rejected the admin key; login=${profile.login}; status=${status}; verify ACE_PUBLISH_KEY_FILE provisioning`);
  if (status === 400) die(`registry rejected the member request; login=${profile.login}; status=400; verify the invite fields`);
  if (status >= 500) die(`registry is unavailable; login=${profile.login}; status=${status}; try again later`);
  if (!result.response.ok) die(`registry invite failed; login=${profile.login}; status=${status}; try again`);
  if (!result.body || result.body.ok !== true) die(`registry returned non-JSON or invalid success; login=${profile.login}; status=${status}; verify membership with --list`);
}

function printArtifacts(artifacts) {
  process.stdout.write(`invited or updated (upsert) ${artifacts.profile.login} (${artifacts.profile.id}) to ${artifacts.targetName}\n`);
  process.stdout.write(`${SETTINGS_START}\n${artifacts.settingsJson}\n${SETTINGS_END}\n`);
  process.stdout.write(`${MESSAGE_START}\n${artifacts.message}\n${MESSAGE_END}\n`);
}

async function listMembers(env, key) {
  const result = await request(`${registryBase(env)}/v1/admin/members`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
  }, env);
  if (result.timeout) die("registry member list timed out; try again");
  const status = result.response.status;
  if (status === 401 || status === 403) die(`registry rejected the admin key; status=${status}; verify ACE_PUBLISH_KEY_FILE provisioning`);
  if (!result.response.ok) die(`registry member list failed; status=${status}; try again`);
  if (!result.body || !Array.isArray(result.body.members)) die(`registry returned non-JSON or invalid member list; status=${status}; try again`);
  const members = result.body.members.slice(0, 100).flatMap((member) => {
    if (!member || !Number.isSafeInteger(member.github_user_id) || member.github_user_id <= 0) return [];
    if (!LOGIN_RE.test(member.github_login || "")) return [];
    return [{ github_login: member.github_login, github_user_id: member.github_user_id }];
  });
  process.stdout.write(`${JSON.stringify({ members }, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  validateInputs(opts, env);
  const key = readAdminKey(env);
  await requireTeamCapabilities(env);

  if (opts.list) {
    await listMembers(env, key);
    return;
  }

  const profile = await resolveGithubProfile(opts.login, env);
  printResolvedProfile(profile);
  if (opts.resolveOnly) {
    process.stderr.write(`No member write performed. Confirm this identity, then rerun with --confirmed; login=${profile.login}\n`);
    return;
  }

  const artifacts = createArtifacts(opts, env, profile);
  await postMember(opts, env, key, profile);
  printArtifacts(artifacts);
}

function runChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

function runShell(script, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script], { env: { ...process.env, ...env }, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function terminalBlockFromMessage(message) {
  const first = "claude plugin update ace";
  const last = "cd ~/team-ace && claude";
  const start = message.indexOf(first);
  const end = message.indexOf(last, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return message.slice(start, end + last.length);
}

async function withFixtureServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      const prefix = req.url.split("/v1/")[0];
      if (req.url.endsWith("/v1/capabilities")) {
        if (prefix === "/captimeout") return setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ target_kind: "team" })); }, 200);
        if (prefix === "/capbadjson") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("not-json"); }
        if (prefix === "/caperror") { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "hidden" })); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ target_kind: prefix === "/public" ? "public" : "team" }));
      } else if (req.method === "GET" && req.url.endsWith("/v1/admin/members")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ members: [{ github_login: "octocat", github_user_id: 583231, note: "must-not-emit" }] }));
      } else if (req.method === "POST" && req.url.endsWith("/v1/admin/members")) {
        if (prefix === "/unauthorized") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ ace_error: "hidden" })); }
        if (prefix === "/forbidden") { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ ace_error: "hidden" })); }
        if (prefix === "/timeout") return setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }, 200);
        if (prefix === "/badjson") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("not-json"); }
        if (prefix === "/badrequest") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ ace_error: "hidden" })); }
        if (prefix === "/servererror") { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ ace_error: "hidden" })); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, github_user_id: 583231 }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await handler(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function extractBetween(text, start, end) {
  const from = text.indexOf(`${start}\n`);
  const to = text.indexOf(`\n${end}`, from + start.length + 1);
  assert.notEqual(from, -1);
  assert.notEqual(to, -1);
  return text.slice(from + start.length + 1, to);
}

async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-invite-selftest-"));
  const keyFile = path.join(tmp, "publish-key");
  const multilineFile = path.join(tmp, "multiline-key");
  const sentinel = "SENTINEL_INVITE_KEY_BYTES";
  fs.writeFileSync(keyFile, `${sentinel}\n`, { mode: 0o600 });
  fs.writeFileSync(multilineFile, `${sentinel}\nSECOND_LINE\n`, { mode: 0o600 });
  const githubOk = JSON.stringify({ login: "octocat", id: 583231, name: "The Octocat", html_url: "https://github.com/octocat" });

  try {
    await withFixtureServer(async (base, requests) => {
      const common = {
        ACE_REGISTRY_URL: base,
        ACE_PUBLISH_KEY_FILE: keyFile,
        ACE_TARGET_NAME: "ace-acme",
        ACE_TARGET_KIND: "team",
        ACE_INVITE_GITHUB_FIXTURE_JSON: githubOk,
      };

      const resolved = await runChild(["octocat", "--home", "/Users/bob", "--resolve-only"], common);
      assert.equal(resolved.status, 0);
      assert.match(resolved.stderr, /login: octocat[\s\S]*id: 583231[\s\S]*display name: The Octocat[\s\S]*profile URL: https:\/\/github.com\/octocat/);
      assert.equal(requests.filter((req) => req.method === "POST").length, 0);
      assert.equal(resolved.output.includes(sentinel), false);
      console.log("PASS resolve-only prints profile and sends zero POST requests");

      const success = await runChild(["octocat", "--home", "/Users/bob", "--note", "colleague", "--confirmed"], common);
      assert.equal(success.status, 0);
      assert.equal(success.output.includes(sentinel), false);
      assert.match(success.stdout, /invited or updated \(upsert\) octocat \(583231\) to ace-acme/);
      const post = requests.find((req) => req.method === "POST");
      assert.equal(post.auth, `Bearer ${sentinel}`);
      assert.deepEqual(JSON.parse(post.body), { github_user_id: 583231, github_login: "octocat", note: "colleague" });
      const settingsJson = extractBetween(success.stdout, SETTINGS_START, SETTINGS_END);
      const settings = JSON.parse(settingsJson);
      assert.deepEqual(settings.env, {
        ACE_REGISTRY_URL: base,
        ACE_TARGET_NAME: "ace-acme",
        ACE_TARGET_KIND: "team",
        ACE_ROLE: "submitter",
        ACE_TOKEN_FILE: "/Users/bob/.ace/acme/claude-code-submitter/token",
        ACE_PROFILE_LAUNCHED: "1",
      });
      const message = extractBetween(success.stdout, MESSAGE_START, MESSAGE_END);
      assert.equal(message, [
        "Paste this whole terminal block:",
        "claude plugin update ace",
        "mkdir -p ~/team-ace/.claude",
        "cat > ~/team-ace/.claude/settings.json <<'ACE_SETTINGS_EOF'",
        settingsJson,
        "ACE_SETTINGS_EOF",
        "cd ~/team-ace && claude",
        "This created a `team-ace` folder in your home directory — that's your team workspace: start Claude from there (`cd ~/team-ace && claude`) whenever you want team ACE; sessions started elsewhere use public ACE.",
        "",
        "Then, inside Claude Code:",
        "/ace:login",
        "/ace:doctor",
        "",
        "The doctor result must say Team ACE ace-acme, submitter, and profile healthy.",
        "If it says Public ACE, stop and tell me.",
      ].join("\n"));

      const pasteHome = path.join(tmp, "paste-home");
      const shimDir = path.join(tmp, "paste-bin");
      fs.mkdirSync(pasteHome, { recursive: true });
      fs.mkdirSync(shimDir, { recursive: true });
      const fakeClaude = path.join(shimDir, "claude");
      fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const paste = await runShell(terminalBlockFromMessage(message), {
        HOME: pasteHome,
        PATH: `${shimDir}:${process.env.PATH || ""}`,
      }, tmp);
      assert.equal(paste.status, 0, paste.stderr);
      assert.equal(fs.readFileSync(path.join(pasteHome, "team-ace", ".claude", "settings.json"), "utf8"), `${settingsJson}\n`);
      console.log("PASS confirmed invite sends correct POST and emits canonical settings + exact one-paste onboarding message without key bytes");
      console.log("PASS emitted terminal block writes settings.json byte-identical to the reference JSON");

      const listed = await runChild(["--list"], common);
      assert.equal(listed.status, 0);
      assert.deepEqual(JSON.parse(listed.stdout), { members: [{ github_login: "octocat", github_user_id: 583231 }] });
      assert.equal(listed.output.includes("must-not-emit"), false);
      assert.equal(listed.output.includes(sentinel), false);
      console.log("PASS --list emits bounded login + id fields only");

      const missing = await runChild(["octocat", "--home", "/Users/bob", "--confirmed"], { ...common, ACE_PUBLISH_KEY_FILE: "" });
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /run this from your admin folder/);
      assert.equal(missing.output.includes(sentinel), false);
      console.log("PASS missing key exits 2 with admin-folder recovery");

      const beforeMalformed = requests.length;
      const malformed = await runChild(["octocat", "--home", "/Users/bob", "--confirmed"], { ...common, ACE_PUBLISH_KEY_FILE: multilineFile });
      assert.equal(malformed.status, 2);
      assert.match(malformed.stderr, /credential file is not a single-line token/);
      assert.equal(requests.length, beforeMalformed);
      assert.equal(malformed.output.includes(sentinel), false);
      console.log("PASS multi-line key is refused before any request without disclosure");

      const publicResult = await runChild(["octocat", "--home", "/Users/bob", "--confirmed"], { ...common, ACE_REGISTRY_URL: `${base}/public` });
      assert.notEqual(publicResult.status, 0);
      assert.match(publicResult.stderr, /not the intended team plane/);
      assert.equal(requests.filter((req) => req.method === "POST" && req.url.startsWith("/public/")).length, 0);
      assert.equal(publicResult.output.includes(sentinel), false);
      console.log("PASS public-plane capability is refused before authenticated write");

      for (const [args, envPatch, expected] of [
        [["bad--login", "--home", "/Users/bob", "--confirmed"], {}, /invalid GitHub login/],
        [["octocat", "--home", "relative/home", "--confirmed"], {}, /absolute path/],
        [["octocat", "--home", "/Users/bob/", "--confirmed"], {}, /absolute path/],
        [["octocat", "--home", "/Users/bob", "--note", "bad`note", "--confirmed"], {}, /without quotes or backticks/],
        [["octocat", "--home", "/Users/bob", "--confirmed"], { ACE_TARGET_NAME: "broken-target" }, /ACE_TARGET_NAME is invalid/],
      ]) {
        const before = requests.length;
        const refusal = await runChild(args, { ...common, ...envPatch });
        assert.equal(refusal.status, 2);
        assert.match(refusal.stderr, expected);
        assert.equal(requests.length, before);
        assert.equal(refusal.output.includes(sentinel), false);
      }
      const noHome = await runChild(["octocat", "--confirmed"], common);
      assert.equal(noHome.status, 2);
      assert.match(noHome.stderr, /ask your colleague: echo \$HOME/);
      console.log("PASS login, note, home, required-home, and target-name validation fail before requests");

      for (const [prefix, expected] of [
        ["unauthorized", /status=401/],
        ["forbidden", /status=403/],
        ["badrequest", /status=400/],
        ["servererror", /status=503/],
        ["badjson", /non-JSON or invalid success/],
        ["timeout", /timed out/],
      ]) {
        const result = await runChild(["octocat", "--home", "/Users/bob", "--confirmed"], {
          ...common,
          ACE_REGISTRY_URL: `${base}/${prefix}`,
          ACE_INVITE_TIMEOUT_MS: prefix === "timeout" ? "50" : "1000",
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
        assert.equal(result.output.includes(sentinel), false);
      }
      console.log("PASS registry 401, 403, 400, 5xx, non-JSON, and timeout failures are bounded and key-safe");

      for (const [prefix, expected] of [
        ["caperror", /status=503/],
        ["capbadjson", /capabilities check failed/],
        ["captimeout", /capabilities check failed/],
      ]) {
        const beforePosts = requests.filter((req) => req.method === "POST").length;
        const result = await runChild(["octocat", "--home", "/Users/bob", "--confirmed"], {
          ...common,
          ACE_REGISTRY_URL: `${base}/${prefix}`,
          ACE_INVITE_TIMEOUT_MS: prefix === "captimeout" ? "50" : "1000",
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
        assert.equal(requests.filter((req) => req.method === "POST").length, beforePosts);
        assert.equal(result.output.includes(sentinel), false);
      }
      console.log("PASS capabilities 5xx, non-JSON, and timeout failures fail closed before authenticated writes");

      for (const fixture of [
        { status: 404, expected: /was not found/ },
        { status: 429, expected: /rate-limited/ },
      ]) {
        const result = await runChild(["octocat", "--home", "/Users/bob", "--resolve-only"], {
          ...common,
          ACE_INVITE_GITHUB_FIXTURE_JSON: JSON.stringify({ status: fixture.status }),
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, fixture.expected);
        assert.equal(result.output.includes(sentinel), false);
      }
      console.log("PASS GitHub 404 and rate-limit failures are clear and key-safe");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes("--selftest")) {
    selftest().catch((error) => {
      console.error(`SELFTEST FAIL: ${error.message}`);
      process.exit(1);
    });
  } else {
    main().catch(() => die("unexpected failure; retry or run /ace:doctor"));
  }
}

module.exports = { createArtifacts, main, parseArgs };
