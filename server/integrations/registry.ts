import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export interface IntegrationModule {
  name: string;
  description: string;
  requiredEnv?: string[];
  createServer: (ctx: IntegrationContext) => Promise<McpSdkServerConfigWithInstance>;
}

export interface IntegrationContext {
  conversationId?: string;
}

const registry = new Map<string, IntegrationModule>();

export function registerIntegration(mod: IntegrationModule): void {
  registry.set(mod.name, mod);
}

export function listIntegrations(): IntegrationModule[] {
  return [...registry.values()];
}

export function getIntegration(name: string): IntegrationModule | undefined {
  return registry.get(name);
}

export async function loadIntegrations(): Promise<void> {
  // Hand-rolled custom integrations (HTTP wrappers that aren't in Composio's
  // catalog). Each one is gated on its own env var so missing keys mean
  // "skip", not "crash".
  if (process.env.CARDTOOL_API_KEY) {
    const { buildCardtoolIntegrationModule } = await import("./cardtool.js");
    registerIntegration(buildCardtoolIntegrationModule());
  }

  if (process.env.ATG_EXEC_SECRET) {
    const { buildAtgExecIntegrationModule } = await import("./atg-exec.js");
    registerIntegration(buildAtgExecIntegrationModule());
  }

  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const loaded = [...registry.keys()];
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — connect a toolkit from the Debug UI's Connections tab)"}`,
  );
}

export async function refreshIntegrations(): Promise<void> {
  registry.clear();
  await loadIntegrations();
}

export function makeContext(conversationId?: string): IntegrationContext {
  return { conversationId };
}

export async function buildMcpServersForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<Record<string, McpSdkServerConfigWithInstance>> {
  const ctx = makeContext(conversationId);
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  let refreshed = false;
  for (const name of names) {
    let mod = registry.get(name);
    if (!mod) {
      if (!refreshed) {
        console.warn(`[integrations] unknown integration: ${name}; refreshing registry`);
        refreshed = true;
        await refreshIntegrations();
        mod = registry.get(name);
      }
      if (!mod) {
        console.warn(`[integrations] unknown integration after refresh: ${name}`);
        continue;
      }
    }
    try {
      out[name] = await mod.createServer(ctx);
    } catch (err) {
      console.error(`[integrations] failed to build ${name}`, err);
    }
  }
  return out;
}
