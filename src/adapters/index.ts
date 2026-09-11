import type { HarnessId } from "./paths.js";

/** Registry: the only place harness adapters are wired into the CLI. */

export interface AdapterSetupResult {
  skillPath: string;
  configPath: string;
  sandbox?: { ok: boolean; added: boolean; alreadyAllowed: boolean };
}

export interface AdapterStatus {
  skillInstalled: boolean;
  mcpRegistered: boolean;
  sandboxAllowed?: boolean;
  configPath: string;
}

export interface Adapter {
  setup(opts: {
    workspaceRoot: string;
    cliEntry: { cmd: string; args: string[] };
    connectorName: string;
  }): AdapterSetupResult;
  status(): AdapterStatus;
}

export async function loadAdapter(harness: HarnessId): Promise<Adapter> {
  switch (harness) {
    case "codex": {
      const mod = await import("./codex.js");
      return {
        setup: mod.setupCodexAdapter,
        status: mod.codexAdapterStatus,
      };
    }
    case "opencode": {
      const mod = await import("./opencode.js");
      return {
        setup: mod.setupOpencodeAdapter,
        status: mod.opencodeAdapterStatus,
      };
    }
    case "zcode": {
      const mod = await import("./zcode.js");
      return {
        setup: mod.setupZcodeAdapter,
        status: mod.zcodeAdapterStatus,
      };
    }
  }
}
