#!/usr/bin/env node
/**
 * Dev watcher for the Docker dev image (docker/Dockerfile.dev).
 *
 * WHY POLLING: Docker Desktop (Windows/macOS) bind mounts are served by
 * VirtioFS / gRPC-FUSE, which does NOT deliver fs.watch/inotify events for
 * host-side changes into the container — tsx watch and node --watch silently
 * never restart. fs.watchFile polls stat() and therefore works on ANY mount.
 * Zero dependencies.
 *
 * Usage: node scripts/dev.mjs <entry-file>   (e.g. src/server.ts)
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/dev.mjs <entry.ts>");
  process.exit(1);
}

const POLL_MS = 400;
const WATCHED_EXT = [".ts", ".json"]; // tsconfig/env-style files also restart
const WATCH_DIRS = ["src"];
let watched = new Set();
let child = null;
let generation = 0;
let restartTimer = null;
let pending = null;

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (WATCHED_EXT.includes(extname(e.name))) out.push(full);
  }
}

function allFiles() {
  const out = [];
  for (const dir of WATCH_DIRS) collect(dir, out);
  return out;
}

function start(gen) {
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  child = spawn(process.execPath, ["--import", "file://" + loader, entry], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (gen !== generation) return; // a newer child replaced this one
    child = null;
    console.log("[dev] process exited (" + (code ?? signal) + ")");
  });
}

function restart(reason) {
  if (restartTimer) {
    pending = reason; // coalesce bursts; restart once the timer fires
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!pending) return;
    console.log("[dev] change detected: " + pending + " — restarting…");
    pending = null;
    const gen = ++generation;
    if (child) {
      child.kill("SIGTERM");
      // Dev loop: graceful shutdown must not stall the reload — hard-kill
      // quickly if the old process lingers (nothing at stake in dev).
      const hard = setTimeout(() => {
        if (gen === generation && child) child.kill("SIGKILL");
      }, 1500);
      child.once("exit", () => {
        clearTimeout(hard);
        if (gen === generation) start(gen);
      });
    } else {
      start(gen);
    }
  }, 120);
  pending = reason;
}

function watchAll() {
  const files = allFiles();
  const fresh = new Set(files);
  for (const f of files) {
    if (watched.has(f)) continue;
    watchFile(f, { interval: POLL_MS }, (curr, prev) => {
      if (!curr || curr.mtimeMs === 0) {
        unwatchFile(f); // deleted
        return;
      }
      if (curr.mtimeMs !== prev.mtimeMs) restart(f);
    });
    watched.add(f);
  }
  for (const f of watched) {
    if (!fresh.has(f)) {
      unwatchFile(f);
      watched.delete(f);
    }
  }
}

watchAll();
setInterval(watchAll, 2000); // pick up newly created files
start(generation);
console.log("[dev] watching " + WATCH_DIRS.join(", ") + " (polling " + POLL_MS + "ms) — " + watched.size + " files, entry=" + entry);
