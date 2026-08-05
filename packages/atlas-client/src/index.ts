/**
 * `@living-atlas/atlas-client` — the typed consumer client for the published
 * Living Atlas knowledge contract.
 *
 * The package root is the NEW plane and nothing else. The client for the
 * thirty-tool surface this contract replaces has not been deleted — the live
 * Cloudflare and canonical-copy scripts in `packages/check` still drive it — but
 * it no longer answers to the name "the Atlas client": it is at
 * `@living-atlas/atlas-client/legacy`, and importing it says so at the import
 * site. See ADR 0019.
 */

export * from "./records.js";
export * from "./tools.js";
export * from "./errors.js";
export * from "./transport.js";
export * from "./stdio-transport.js";
export * from "./client.js";
