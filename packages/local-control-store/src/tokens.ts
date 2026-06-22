import { Sha256HashSchema } from "@living-atlas/contracts";

export async function sha256LocalControlToken(token: string): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return Sha256HashSchema.parse(`sha256:${hex}`) as `sha256:${string}`;
}
