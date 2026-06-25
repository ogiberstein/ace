#!/usr/bin/env node
// Host-neutral ACE login helper.
// Starts the GitHub device flow, writes the issued ACE consumer token to
// ACE_TOKEN_FILE (default ~/.ace/token), and never prints the token value.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_REGISTRY_URL = "https://ace-registry.ogiberstein.workers.dev";

function envOrDefault(value, fallback) {
  if (!value || value.startsWith("${")) return fallback;
  return value;
}

function usage() {
  console.log(`ACE login helper

Usage:
  node plugins/ace/scripts/login.cjs [options]
  node plugins/ace/scripts/login.cjs --check [options]

Options:
  --registry URL       ACE registry URL (default: $ACE_REGISTRY_URL or ${DEFAULT_REGISTRY_URL})
  --token-file PATH    Token file path (default: $ACE_TOKEN_FILE or ~/.ace/token)
  --timeout SECONDS    Device-flow timeout cap (default: server expires_in)
  --no-browser         Do not try to open the verification URL
  --check              Verify the existing token by calling /v1/me; does not start login
  -h, --help           Show this help

Security:
  This helper never prints the returned Bearer token. It writes the token file
  with mode 0600 and prints only non-secret status such as path, mode, and login.
`);
}

function parseArgs(argv) {
  const opts = {
    registry: envOrDefault(process.env.ACE_REGISTRY_URL, DEFAULT_REGISTRY_URL),
    tokenFile: envOrDefault(process.env.ACE_TOKEN_FILE, path.join(os.homedir(), ".ace", "token")),
    timeout: null,
    noBrowser: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--registry") {
      opts.registry = requireValue(argv, ++i, arg);
    } else if (arg === "--token-file") {
      opts.tokenFile = requireValue(argv, ++i, arg);
    } else if (arg === "--timeout") {
      const raw = requireValue(argv, ++i, arg);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) die(`invalid --timeout: ${raw}`);
      opts.timeout = Math.floor(n);
    } else if (arg === "--no-browser") {
      opts.noBrowser = true;
    } else if (arg === "--check") {
      opts.check = true;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  opts.registry = String(opts.registry).replace(/\/$/, "");
  opts.tokenFile = expandHome(String(opts.tokenFile));
  return opts;
}

function requireValue(argv, i, flag) {
  if (i >= argv.length || argv[i].startsWith("--")) die(`${flag} requires a value`);
  return argv[i];
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function die(message, code = 1) {
  console.error(`ACE login error: ${message}`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}) {
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    die(`request failed for ${url}: ${err.message}`);
  }
  let body = null;
  try {
    body = await resp.json();
  } catch {
    body = {};
  }
  return { resp, body };
}

function maybeOpenBrowser(url) {
  if (!url) return;
  const commands = [];
  if (process.platform === "darwin") commands.push(["open", [url]]);
  else if (process.platform === "win32") commands.push(["cmd", ["/c", "start", "", url]]);
  else commands.push(["xdg-open", [url]]);
  for (const [cmd, args] of commands) {
    const result = spawnSync(cmd, args, { stdio: "ignore", timeout: 3000 });
    if (result.status === 0) return;
  }
}

function modeString(filePath) {
  const st = fs.statSync(filePath);
  return `0${(st.mode & 0o777).toString(8)}`;
}

function writeToken(filePath, token) {
  if (!token || typeof token !== "string") die("registry did not return a token");
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: existing parent may not be owned by the current user.
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

async function checkExisting(opts) {
  if (!fs.existsSync(opts.tokenFile)) die(`token file does not exist: ${opts.tokenFile}`);
  const token = fs.readFileSync(opts.tokenFile, "utf8").trim();
  if (!token) die(`token file is empty: ${opts.tokenFile}`);
  const { resp, body } = await fetchJson(`${opts.registry}/v1/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    die(`existing token check failed: HTTP ${resp.status} ${body.ace_error || body.error || ""}`.trim());
  }
  console.log(`ACE token ok for ${body.github_login || "unknown-user"}`);
  console.log(`registry: ${opts.registry}`);
  console.log(`token file: ${opts.tokenFile} (${modeString(opts.tokenFile)})`);
}

async function login(opts) {
  console.log(`ACE registry: ${opts.registry}`);
  console.log(`token file: ${opts.tokenFile}`);

  const { resp: startResp, body: start } = await fetchJson(`${opts.registry}/v1/auth/device/start`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!startResp.ok) die(`device-flow start failed: HTTP ${startResp.status} ${start.ace_error || start.error || ""}`.trim());
  if (!start.device_code || !start.user_code || !start.verification_uri) {
    die("device-flow start response missing device_code/user_code/verification_uri");
  }

  console.log("\nOpen this GitHub URL and enter the code:");
  console.log(`  URL:  ${start.verification_uri}`);
  console.log(`  Code: ${start.user_code}`);
  if (start.verification_uri_complete) {
    console.log(`  Direct URL: ${start.verification_uri_complete}`);
  }
  console.log("\nWaiting for GitHub authorization. The ACE token will not be printed.");

  if (!opts.noBrowser) maybeOpenBrowser(start.verification_uri_complete || start.verification_uri);

  const startedAt = Date.now();
  const expiresIn = Number(start.expires_in || 900);
  const timeout = opts.timeout ? Math.min(opts.timeout, expiresIn) : expiresIn;
  let interval = Math.max(1, Number(start.interval || 5));

  while ((Date.now() - startedAt) / 1000 < timeout) {
    await sleep(interval * 1000);
    const { resp, body } = await fetchJson(`${opts.registry}/v1/auth/device/claim`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });

    if (resp.status === 404) {
      process.stdout.write(".");
      continue;
    }
    if (resp.status === 429) {
      interval = Math.max(interval + 1, Number(body.retry_after || resp.headers.get("Retry-After") || interval + 5));
      process.stdout.write(".");
      continue;
    }
    if (resp.status === 410) {
      console.log("");
      die(`device code expired or was denied: ${body.ace_error || body.error || "restart login"}`);
    }
    if (!resp.ok) {
      console.log("");
      die(`device-flow claim failed: HTTP ${resp.status} ${body.ace_error || body.error || ""}`.trim());
    }

    writeToken(opts.tokenFile, body.token);
    console.log("\nACE login complete.");
    console.log(`logged in as: ${body.github_login || "unknown-user"}`);
    console.log(`wrote token file: ${opts.tokenFile} (${modeString(opts.tokenFile)})`);
    if (body.privacy_notice) console.log(`privacy: ${body.privacy_notice}`);
    return;
  }

  console.log("");
  die("device-flow login timed out; restart login");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) await checkExisting(opts);
  else await login(opts);
}

main().catch((err) => die(err && err.message ? err.message : String(err)));
