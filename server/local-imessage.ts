import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizeE164(n: string): string {
  const trimmed = n.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export async function sendLocalImessage(to: string, body: string): Promise<void> {
  const recipient = normalizeE164(to);
  if (!recipient) throw new Error("[imsg] recipient is empty");
  const { stdout, stderr } = await execFileAsync("imsg", [
    "send",
    "--to",
    recipient,
    "--text",
    body,
    "--service",
    "imessage",
    "--json",
  ]);

  const output = stdout.trim();
  if (!output) return;
  try {
    const parsed = JSON.parse(output) as { success?: boolean; error?: string };
    if (parsed.success === false) {
      throw new Error(parsed.error ?? output);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`[imsg] unexpected send output: ${output}${stderr ? ` ${stderr}` : ""}`);
    }
    throw err;
  }
}
