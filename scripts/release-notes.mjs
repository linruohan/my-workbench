#!/usr/bin/env node
/**
 * Build release notes from conventional-style commits between two tags.
 *
 * Usage:
 *   node scripts/release-notes.mjs [tag] [--out path] [--from tag]
 *
 * Defaults: tag = latest v* tag (or package.json version), from = previous v* tag.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SECTIONS = [
  { id: "feat", title: "新增功能", types: ["feat"] },
  { id: "fix", title: "问题修复", types: ["fix", "bugfix"] },
  { id: "improve", title: "改进优化", types: ["improve", "perf", "refactor", "enhance"] },
  { id: "docs", title: "文档", types: ["docs"] },
  { id: "other", title: "其他变更", types: ["chore", "ci", "build", "test", "style", "other"] },
];

const TYPE_TO_SECTION = new Map(
  SECTIONS.flatMap((section) => section.types.map((type) => [type, section.id])),
);

const SUBJECT_RE =
  /^(feat|fix|bugfix|improve|perf|refactor|enhance|docs|chore|ci|build|test|style)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
}

function parseArgs(argv) {
  const out = { tag: null, from: null, outPath: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      out.outPath = argv[++i] ?? null;
      continue;
    }
    if (arg === "--from") {
      out.from = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }
    rest.push(arg);
  }
  out.tag = rest[0] ?? null;
  return out;
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return String(pkg.version || "").trim();
}

function listVersionTags() {
  const raw = git(["tag", "-l", "v*", "--sort=-v:refname"], { allowFail: true });
  return raw
    ? raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function normalizeTag(tag) {
  if (!tag) return null;
  if (tag === "v__VERSION__") return `v${packageVersion()}`;
  return tag.startsWith("v") ? tag : `v${tag}`;
}

function previousTag(tag, tags) {
  const index = tags.indexOf(tag);
  if (index >= 0) return tags[index + 1] ?? null;
  // Tag not created yet — treat as newer than the current latest.
  return tags[0] ?? null;
}

function commitRange(from, to) {
  if (from) return `${from}..${to}`;
  return to;
}

function parseSubject(subject) {
  const text = subject.trim();
  if (!text) return null;
  if (/^merge\b/i.test(text)) return null;
  if (/^chore\(release\):/i.test(text)) return null;
  if (/^bump version\b/i.test(text)) return null;
  // Skip placeholder one-word commits.
  if (/^(add|wip|tmp|update|misc)$/i.test(text)) return null;

  const match = text.match(SUBJECT_RE);
  if (match) {
    const type = match[1].toLowerCase();
    const scope = match[2]?.trim() || "";
    const summary = match[3].trim();
    return {
      section: TYPE_TO_SECTION.get(type) ?? "other",
      scope,
      summary,
      raw: text,
    };
  }

  // Bare "add …" / Chinese subjects fall into other.
  return {
    section: "other",
    scope: "",
    summary: text,
    raw: text,
  };
}

function loadCommits(range) {
  const raw = git(["log", range, "--pretty=format:%s", "--no-merges"], {
    allowFail: true,
  });
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => parseSubject(line))
    .filter(Boolean);
}

function formatItem(item) {
  return item.scope ? `- **${item.scope}**：${item.summary}` : `- ${item.summary}`;
}

function buildNotes({ tag, from, commits }) {
  const lines = [`## 变更（${tag}${from ? ` ← ${from}` : ""}）`, ""];
  let wrote = false;

  for (const section of SECTIONS) {
    const items = commits.filter((item) => item.section === section.id);
    if (items.length === 0) continue;
    // Deduplicate identical display lines while preserving order.
    const seen = new Set();
    const unique = [];
    for (const item of items) {
      const line = formatItem(item);
      if (seen.has(line)) continue;
      seen.add(line);
      unique.push(line);
    }
    lines.push(`### ${section.title}`, ...unique, "");
    wrote = true;
  }

  if (!wrote) {
    lines.push("- 无分类提交说明（可能仅含版本号或构建调整）", "");
  }

  lines.push(
    "## 安装说明",
    "- Windows：下载 `.msi` 或 `.exe` 安装包",
    "- macOS：下载对应架构的 `.dmg` / `.app.tar.gz`",
    "- Linux：下载 `.AppImage` / `.deb`",
    "",
    "详见仓库 `docs/packaging.md`。",
    "",
  );

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tags = listVersionTags();
  const tag = normalizeTag(args.tag) ?? tags[0] ?? `v${packageVersion()}`;
  const from = normalizeTag(args.from) ?? previousTag(tag, tags);
  const tip = git(["rev-parse", "--verify", `${tag}^{commit}`], { allowFail: true })
    ? tag
    : "HEAD";
  const range = commitRange(from, tip);
  const commits = loadCommits(range);
  const notes = buildNotes({ tag, from, commits });

  if (args.outPath) {
    writeFileSync(args.outPath, notes, "utf8");
  } else {
    process.stdout.write(notes);
  }
}

main();
