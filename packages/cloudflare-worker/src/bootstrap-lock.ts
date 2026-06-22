import {
  BootstrapClaimPayloadSchema,
  type BootstrapClaimPayload,
  type BootstrapClaimRecord,
  type BootstrapClaimResult,
  type BootstrapRuntimeConfig,
  type BootstrapStatus,
  configToInitialState,
  isClaimTokenExpired,
  verifyClaimToken
} from "./bootstrap";

export interface BootstrapClaimLockStorage {
  getClaimRecord(): Promise<BootstrapClaimRecord | undefined>;
  putClaimRecord(record: BootstrapClaimRecord): Promise<void>;
}

export class InMemoryBootstrapClaimLockStorage implements BootstrapClaimLockStorage {
  private claimRecord: BootstrapClaimRecord | undefined;

  async getClaimRecord(): Promise<BootstrapClaimRecord | undefined> {
    return this.claimRecord;
  }

  async putClaimRecord(record: BootstrapClaimRecord): Promise<void> {
    this.claimRecord = record;
  }
}

export class BootstrapClaimLockCore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: BootstrapClaimLockStorage) {}

  async getStatus(config: BootstrapRuntimeConfig): Promise<BootstrapStatus> {
    const record = await this.storage.getClaimRecord();
    if (record) {
      return {
        bootstrap_state: "claimed",
        authority_id: record.authority_id,
        claimed_at: record.claimed_at,
        policy_generation: record.policy_generation,
        claim_token_burned_at: record.claim_token_burned_at,
        reset_generation: record.reset_generation
      };
    }

    return {
      bootstrap_state: configToInitialState(config),
      reset_generation: 0
    };
  }

  async claim(input: unknown, token: string | undefined, config: BootstrapRuntimeConfig, nowIso: string): Promise<BootstrapClaimResult> {
    return this.enqueue(async () => {
      const existingStatus = await this.getStatus(config);
      if (existingStatus.bootstrap_state === "claimed") {
        return { ok: false, status: existingStatus, reason: "already-claimed" };
      }

      if (existingStatus.bootstrap_state === "sealed") {
        return { ok: false, status: existingStatus, reason: "sealed" };
      }

      if (!token) {
        return { ok: false, status: existingStatus, reason: "missing-token" };
      }

      if (isClaimTokenExpired(config, nowIso)) {
        return { ok: false, status: existingStatus, reason: "expired-token" };
      }

      if (!(await verifyClaimToken(token, config.claim_token_hash))) {
        return { ok: false, status: existingStatus, reason: "invalid-token" };
      }

      const parsedPayload = BootstrapClaimPayloadSchema.safeParse(input);
      if (!parsedPayload.success) {
        return { ok: false, status: existingStatus, reason: "malformed-claim" };
      }

      const payload: BootstrapClaimPayload = parsedPayload.data;
      const record: BootstrapClaimRecord = {
        bootstrap_state: "claimed",
        authority_id: payload.authority_id,
        claimed_at: nowIso,
        claimed_by_device_public_key_hash: payload.device_public_key_hash,
        policy_generation: payload.policy_generation,
        claim_token_burned_at: nowIso,
        reset_generation: 0
      };

      await this.storage.putClaimRecord(record);
      return {
        ok: true,
        status: await this.getStatus(config),
        record
      };
    });
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
