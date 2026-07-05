import type { SignedEscalationGrant } from "@living-atlas/remote-crypto";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";

export type OracleClientResult =
  | { ok: true; plaintext: { kind: "plaintext-json"; data: Record<string, unknown> } }
  | { ok: false; reason: "owner-offline" | "oracle-denied" };

export async function callDecryptionOracle(
  fetchImpl: typeof fetch,
  oracleUrl: string,
  input: { grant: SignedEscalationGrant; object: GraphObjectEnvelope }
): Promise<OracleClientResult> {
  let response: Response;
  try {
    response = await fetchImpl(oracleUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: input.grant, object: input.object })
    });
  } catch {
    return { ok: false, reason: "owner-offline" };
  }
  if (response.status !== 200) {
    return { ok: false, reason: "oracle-denied" };
  }
  const body = (await response.json()) as OracleClientResult;
  return body.ok ? body : { ok: false, reason: "oracle-denied" };
}
