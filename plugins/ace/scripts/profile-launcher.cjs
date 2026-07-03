#!/usr/bin/env node
const cp = require("child_process");
const path = require("path");

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
  --kind <public|team>     target kind; Team ACE uses team-shared wording
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
function parse(argv) {
  const out = { cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--") { out.cmd = argv.slice(i + 1); break; }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[++i];
  }
  return out;
}
function die(msg) { console.error(`ace profile launch: ${msg}\nRun: node scripts/profile-launcher.cjs --help`); process.exit(2); }
const args = parse(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
const role = args.role;
if (!["retrieval", "submitter", "admin"].includes(role)) die("--role must be retrieval, submitter, or admin");
if (!args.url) die("--url required");
if (!args.tokenFile) die("--token-file required");
if (role === "admin" && !args.publishKeyFile) die("admin requires --publish-key-file");
if (role === "submitter" && args.publishKeyFile && args.publishKeyFile !== "__ACE_NO_PUBLISH_KEY__") die("submitter must not receive --publish-key-file");
const env = {
  ...process.env,
  ACE_PROFILE_LAUNCHED: "1",
  ACE_TARGET_NAME: args.target || "ace-target",
  ACE_TARGET_KIND: args.kind || "team",
  ACE_REGISTRY_URL: args.url,
  ACE_ROLE: role,
  ACE_TOKEN_FILE: args.tokenFile,
  ACE_EXPOSE_GET: role === "retrieval" ? (args.exposeGet || "0") : "1",
  ACE_SUBMIT_MODE: role === "submitter" || role === "admin" ? "1" : "0",
  ACE_ADMIN_MODE: role === "admin" ? "1" : "0",
};
if (role === "admin") env.ACE_PUBLISH_KEY_FILE = args.publishKeyFile;
else delete env.ACE_PUBLISH_KEY_FILE;
if (args.dryRun || args.printEnv) {
  for (const k of ["ACE_PROFILE_LAUNCHED", "ACE_TARGET_NAME", "ACE_TARGET_KIND", "ACE_REGISTRY_URL", "ACE_ROLE", "ACE_TOKEN_FILE", "ACE_PUBLISH_KEY_FILE", "ACE_EXPOSE_GET", "ACE_SUBMIT_MODE", "ACE_ADMIN_MODE"]) {
    if (env[k]) console.log(`${k}=${env[k]}`);
  }
  process.exit(0);
}
const cmd = args.cmd.length ? args.cmd : ["claude"];
console.error(`Launching ${env.ACE_TARGET_KIND} ${env.ACE_TARGET_NAME} as ${role}; token/key contents hidden.`);
const child = cp.spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, cwd: process.cwd() });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
