/**
 * Progress notification shape emitted per step. Mirrors the payload the MCP SDK
 * carries in `notifications/progress` (`progress`/`total`), so the agent's tool
 * handler can forward it verbatim through `RequestHandlerExtra.sendNotification`
 * (@modelcontextprotocol/sdk 1.29.0, shared/protocol.d.ts) without reshaping.
 *
 * This module proves *our* handler yields incremental progress before its final
 * result. Resumability + `Last-Event-ID` replay are the SDK transport's job
 * (agents 0.17.3 `McpAgent#getEventStore()` -> `DurableObjectEventStore`); we do
 * NOT hand-roll an event store or SSE framing here.
 */
export type ProgressNotification = { progress: number; total: number };

export async function runStreamingTool<T>(input: {
  totalSteps: number;
  onProgress: (p: ProgressNotification) => Promise<void>;
  work: (step: number) => Promise<T>;
}): Promise<{ ok: true; steps: T[] }> {
  const steps: T[] = [];
  for (let step = 0; step < input.totalSteps; step += 1) {
    steps.push(await input.work(step));
    await input.onProgress({ progress: step + 1, total: input.totalSteps });
  }
  return { ok: true, steps };
}
