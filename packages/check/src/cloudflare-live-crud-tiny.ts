import { pathToFileURL } from "node:url";
import { liveCrudStressEnv, printCloudflareLiveCrudStressResult, runCloudflareLiveCrudStress } from "./cloudflare-live-crud-stress";
import { printCloudflareLiveUsageGateResult, runCloudflareLiveUsageGate } from "./cloudflare-live-usage-gate";

const mutationAcknowledgement = "mutates-deployed-sync-state";
const tinyAckEnv = "LIVING_ATLAS_LIVE_TINY_CRUD_ACK";

export async function main(): Promise<void> {
  if (process.env[tinyAckEnv] !== mutationAcknowledgement) {
    console.error(`${tinyAckEnv} must equal ${mutationAcknowledgement}`);
    process.exitCode = 2;
    return;
  }

  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    process.exitCode = 2;
    return;
  }

  const env = {
    ...process.env,
    [liveCrudStressEnv.acknowledgeMutation]: mutationAcknowledgement,
    [liveCrudStressEnv.entryCount]: process.env[liveCrudStressEnv.entryCount] ?? "12",
    [liveCrudStressEnv.batchSize]: process.env[liveCrudStressEnv.batchSize] ?? "12"
  };
  const result = await runCloudflareLiveCrudStress({
    env,
    onProgress: (message) => console.log(`[live-crud-tiny] ${message}`)
  });
  printCloudflareLiveCrudStressResult(result);
  if (!result.ok) {
    process.exitCode = result.cases.length === 0 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
