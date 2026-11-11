// Updates the "live repositories" section of README.md with the current state
// of every repository (public + private) owned by the token's user.
//
// Env:
//   GH_TOKEN       Personal access token with read access to all repos (required for private repos)
//   PRIVATE_REPOS  show | mask (default) | hide  — how private repos appear in the PUBLIC README
//   MAX_REPOS      max rows in the table (default 20)
//   GITHUB_API_URL API base (default https://api.github.com)
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const TOKEN = process.env.GH_TOKEN;
const MODE = ["show", "hide"].includes(process.env.PRIVATE_REPOS) ? process.env.PRIVATE_REPOS : "mask";
const MAX = Number(process.env.MAX_REPOS || 20);
const README = process.env.README_PATH || "README.md";
const START = "<!-- REPO-STATUS:START -->";
const END = "<!-- REPO-STATUS:END -->";
const DAY = 24 * 3600 * 1000;

if (!TOKEN) throw new Error("GH_TOKEN is missing: add a REPO_STATUS_TOKEN secret (PAT with repo read access).");

async function gh(path) {
  const res = await fetch(API + path, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "profile-repo-status",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path.split("?")[0]}`);
  return res.json();
}

async function listRepos() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/user/repos?affiliation=owner&visibility=all&sort=pushed&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function latestRun(repo) {
  try {
    const data = await gh(
      `/repos/${repo.full_name}/actions/runs?per_page=1&branch=${encodeURIComponent(repo.default_branch)}`
    );
    return data.workflow_runs[0];
  } catch {
    return undefined; // Actions disabled, empty repo…
  }
}

function ci(run) {
  if (!run) return "➖";
  if (run.status !== "completed") return "🟡 running";
  if (["success", "neutral", "skipped"].includes(run.conclusion)) return "🟢 passing";
  if (run.conclusion === "cancelled") return "⚪ cancelled";
  return "🔴 failing";
}

function when(iso) {
  return iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : "—";
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

async function main() {
  let repos = (await listRepos()).filter((r) => !r.archived);
  if (MODE === "hide") repos = repos.filter((r) => !r.private);
  repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const shown = repos.slice(0, MAX);
  const runs = await Promise.all(shown.map(latestRun));

  const pub = repos.filter((r) => !r.private).length;
  const priv = repos.length - pub;
  const active24 = repos.filter((r) => Date.now() - new Date(r.pushed_at) < DAY).length;
  const active7 = repos.filter((r) => Date.now() - new Date(r.pushed_at) < 7 * DAY).length;
  const failing = runs.filter((r) => ci(r).includes("failing")).length;

  let privateIndex = 0;
  const rows = shown.map((r, i) => {
    const masked = r.private && MODE === "mask";
    const fresh = Date.now() - new Date(r.pushed_at) < DAY ? " 🔥" : "";
    const name = masked ? `🔒 *Private project #${++privateIndex}*` : `${r.private ? "🔒" : "🌍"} [${esc(r.name)}](${r.html_url})`;
    const desc = masked ? "" : esc(r.description).slice(0, 70);
    const ciCell = !masked && runs[i] ? `[${ci(runs[i])}](${runs[i].html_url})` : ci(runs[i]);
    return `| ${name}${fresh} | ${desc} | ${ciCell} | ${when(r.pushed_at)} | ${r.open_issues_count} | ${esc(r.language) || "—"} |`;
  });

  const body = [
    `| 📦 Repos | 🌍 Public | 🔒 Private | 🔥 Active 24h | 📅 Active 7d | 🔴 CI failing |`,
    `|:---:|:---:|:---:|:---:|:---:|:---:|`,
    `| **${repos.length}** | ${pub} | ${priv} | ${active24} | ${active7} | ${failing} |`,
    ``,
    `| Repository | Description | CI | Last push | Issues/PRs | Language |`,
    `|---|---|---|---|:---:|---|`,
    ...rows,
    ``,
    repos.length > MAX ? `<sub>Showing the ${MAX} most recently updated of ${repos.length} repositories.</sub>` : "",
  ].join("\n");

  const readme = await readFile(README, "utf8");
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1) throw new Error(`Markers ${START} / ${END} not found in ${README}`);

  // Fingerprint of the real state: only commit when something actually changed.
  const state = shown
    .map((r, i) => [r.id, r.pushed_at, r.open_issues_count, ci(runs[i]), Date.now() - new Date(r.pushed_at) < DAY].join(":"))
    .join("|");
  const fingerprint = createHash("sha1").update(`${MODE}|${repos.length}|${pub}|${active24}|${active7}|${state}`).digest("hex").slice(0, 12);
  const current = readme.slice(s + START.length, e);
  if (current.includes(`fingerprint:${fingerprint}`) && process.env.FORCE !== "1") {
    console.log("No change in repository state — README untouched.");
    return;
  }
  const stamp = `<sub>⏱️ Auto-updated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · times in UTC</sub>`;
  const updated = readme.slice(0, s + START.length) + `\n<!-- fingerprint:${fingerprint} -->\n${body}\n${stamp}\n` + readme.slice(e);
  await writeFile(README, updated);
  console.log(`README updated: ${repos.length} repos (${pub} public / ${priv} private), ${failing} failing.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
