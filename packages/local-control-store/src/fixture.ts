import {
  controlPlaneFixture,
  fixtureAuthorityId,
  fixtureLocalClientId
} from "@living-atlas/fixtures";
import { type LocalControlState } from "@living-atlas/contracts";
import { sha256LocalControlToken } from "./tokens";

const fixtureTimestamp = "2026-06-21T12:00:00.000Z";

export async function createFixtureLocalControlState(localMcpToken: string): Promise<LocalControlState> {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    control_plane: controlPlaneFixture,
    local_credentials: [
      {
        credential_id: "la_local_credential_fixture0001",
        client_id: fixtureLocalClientId,
        capability_id: "la_cap_localfull0001",
        token_hash: await sha256LocalControlToken(localMcpToken),
        created_at: fixtureTimestamp
      }
    ],
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp
  };
}
