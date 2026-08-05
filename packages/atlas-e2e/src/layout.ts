import { join } from "node:path";

/**
 * Where each part of the harness store lives under one data directory.
 *
 * Its own module, not a member of the server entry, because BOTH sides need it:
 * the parent writes the credential file and reads the audit log, the child opens
 * the two segment logs. Exporting it from the entry would mean importing the
 * entry, and importing an entry point runs it — a server would boot inside the
 * test process the moment anything asked where the audit log is.
 *
 * The assertion log and the identity log get separate directories because
 * atlas-core refuses to load a directory holding both: an assertion record found
 * by the identity reader means two logs were written into one place, and it says
 * so rather than skipping what it does not understand.
 */
export type HarnessLayout = {
  assertions: string;
  identity: string;
  auditLog: string;
  credentials: string;
};

export function layoutFor(dataDirectory: string): HarnessLayout {
  return {
    assertions: join(dataDirectory, "assertions"),
    identity: join(dataDirectory, "identity"),
    auditLog: join(dataDirectory, "audit.log"),
    credentials: join(dataDirectory, "credentials.json")
  };
}
