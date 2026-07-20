#!/usr/bin/env node
import { buildLocalMcpContextFromEnv } from "./context-from-env";
import { runLivingAtlasLocalMcpStdio } from "./server";

/**
 * Standalone single-connection stdio entrypoint: opens its own FileLocalGraphStore
 * directly for the lifetime of this process. Safe for exactly one client. For
 * multiple simultaneous local clients (Claude Desktop + Codex + Claude Code +
 * ...) against the same replica, point clients at proxy.ts instead, which
 * shares one FileLocalGraphStore through the daemon rather than each client
 * opening its own.
 */
try {
  const { context, authorizationHeader } = await buildLocalMcpContextFromEnv();
  await runLivingAtlasLocalMcpStdio(context, { authorizationHeader });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
