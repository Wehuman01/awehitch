import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Absolute directories probed for tunnel binaries (unit-tested for the HOME-unset case). */
export function commonDirs(): string[] {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "C:\\Program Files\\cloudflared",
    "C:\\Program Files (x86)\\cloudflared",
  ];
  const home = process.env.HOME?.trim();
  // With HOME unset, path.join("", ...) yields a relative dir that
  // path.resolve() pins to the CWD — never probe there.
  if (home) dirs.push(path.join(home, ".local", "bin"));
  return dirs;
}

function accessibleFile(candidate: string): string | null {
  try {
    const resolved = path.resolve(candidate);
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.F_OK | fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/** Locate a binary on PATH or in common install locations. */
export function findBinary(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (name === "cloudflared" && process.env.AWEHITCH_CLOUDFLARED_PATH?.trim()) {
    const configured = accessibleFile(process.env.AWEHITCH_CLOUDFLARED_PATH.trim());
    if (configured) return configured;
  }
  try {
    const probe = spawnSync(exe, ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (probe.status === 0 || probe.status === 1) return exe; // on PATH
  } catch {
    // not on PATH
  }
  for (const dir of commonDirs()) {
    const full = path.join(dir, exe);
    const configured = accessibleFile(full);
    if (configured) return configured;
  }
  return null;
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
