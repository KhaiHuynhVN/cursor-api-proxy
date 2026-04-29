import type { BridgeConfig } from "./config.js";

/**
 * CLI flags and options for the Cursor agent, excluding the final prompt argument.
 */
export function buildAgentFixedArgs(
  config: BridgeConfig,
  workspaceDir: string,
  model: string,
  stream: boolean,
): string[] {
  const args = ["--print"];
  if (config.approveMcps) args.push("--approve-mcps");
  if (config.force) args.push("--force");
  if (config.chatOnlyWorkspace) args.push("--trust");
  // Removed --mode ask to allow full model responses (not constrained to ask-only)
  args.push("--workspace", workspaceDir);
  args.push("--model", model);
  if (stream) {
    args.push("--stream-partial-output", "--output-format", "stream-json");
  } else {
    args.push("--output-format", "text");
  }
  return args;
}

/**
 * Build CLI arguments for running the Cursor agent.
 */
export function buildAgentCmdArgs(
  config: BridgeConfig,
  workspaceDir: string,
  model: string,
  prompt: string,
  stream: boolean,
): string[] {
  return [...buildAgentFixedArgs(config, workspaceDir, model, stream), prompt];
}
