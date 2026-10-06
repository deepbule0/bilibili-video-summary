import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// Offline checks only. Never print a matched credential or contact a provider.
// Heuristics supplement manual review; they cannot prove that no secret exists.
function git(args, input) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Git audit failed: ${args[0]}`);
  return result.stdout;
}

const trackedOnly = process.argv.includes("--tracked-only");
const paths = git(["ls-files", "-z", ...(trackedOnly ? [] : ["--cached", "--others", "--exclude-standard"])])
  .split("\0").filter(Boolean);
const forbidden = /(?:^|\/)(?:node_modules|\.venv|outputs|work|\.wrangler|\.sites-runtime)\/|(?:^|\/)\.env(?!\.example$)(?:\.|$)|\.(?:gguf|safetensors|ckpt|onnx|pt|pth|sqlite3?|db|pem|key|p12|pfx|mp[34]|m4a|wav|part|log)$/i;
const patterns = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/g],
  ["Credential in URL", /https?:\/\/[^\s/:@]{1,64}:[^\s/@]{8,}@/g],
  ["Literal credential", /\b(?:[A-Z_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|SESSDATA))\s*[:=]\s*["'](?!example|placeholder|your[-_]|replace[-_]|test[-_])[A-Za-z0-9+/=_-]{16,}["']/gi],
];
const findings = [];
function scan(label, text) {
  for (const [rule, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ file: label, rule, line: text.slice(0, match.index).split("\n").length });
    }
  }
}
for (const file of paths) {
  if (forbidden.test(file) || file === "35B模型调用交接.md") findings.push({ file, rule: "Private/generated file" });
  const size = statSync(file).size;
  if (size > 5 * 1024 * 1024) findings.push({ file, rule: "File larger than 5 MiB" });
  else scan(file, readFileSync(file, "utf8"));
}

let historyBlobs = 0;
if (process.argv.includes("--history")) {
  const objects = git(["rev-list", "--objects", "--all"]).trim().split("\n");
  const names = new Map(objects.map((line) => {
    const space = line.indexOf(" ");
    return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
  }));
  const inventory = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], [...names.keys()].join("\n") + "\n");
  for (const line of inventory.trim().split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type !== "blob") continue;
    historyBlobs++;
    const file = names.get(sha) || "unknown";
    const label = `history:${sha.slice(0, 12)}:${file}`;
    if (forbidden.test(file)) findings.push({ file: label, rule: "Private/generated file in history" });
    if (Number(size) > 5 * 1024 * 1024) findings.push({ file: label, rule: "Large blob in history" });
    else scan(label, git(["cat-file", "blob", sha]));
  }
}
console.log(JSON.stringify({ files: paths.length, historyBlobs, findings, status: findings.length ? "REVIEW_REQUIRED" : "PASS" }, null, 2));
if (findings.length) process.exitCode = 1;
