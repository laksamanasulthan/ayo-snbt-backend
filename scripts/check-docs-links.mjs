#!/usr/bin/env node
// Dependency-free docs link checker.
// Walks docs/ + root *.md (excluding node_modules) and resolves every
// relative link/image target. Exits 1 on any broken link.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, extname, join } from "node:path";

const ROOT = process.cwd();
const mdFiles = [];

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (entry.isFile() && full.endsWith(".md") && (dir.startsWith(join(ROOT, "docs")) || dir === ROOT)) {
      mdFiles.push(full);
    }
  }
}

walk(ROOT);

let errors = 0;
for (const file of mdFiles) {
  const content = readFileSync(file, "utf-8");
  const dir = dirname(file);
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)|!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const raw = match[2] ?? match[4];
    if (!raw) continue;
    if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("#") || raw.startsWith("mailto:")) continue;
    const path = raw.split("#")[0];
    if (!path) continue;
    const resolved = resolve(dir, path);
    if (!existsSync(resolved)) {
      console.error(`BROKEN LINK: ${file.replace(ROOT, ".")} → "${raw}"`);
      errors++;
    } else if (statSync(resolved).isDirectory()) {
      // linking to a directory is allowed (e.g. ./adr/)
    }
  }
}

if (errors > 0) {
  console.error(`\n${errors} broken link(s) found.`);
  process.exit(1);
}
console.log(`All links OK (${mdFiles.length} markdown files checked).`);
