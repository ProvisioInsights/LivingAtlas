import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { IsoTimestampSchema } from "@living-atlas/contracts";

export const DEFAULT_LOCAL_INSTALL_DIR_NAME = ".living-atlas";
export const DEFAULT_LOCAL_PROFILE_NAME = "default";
export const DEFAULT_LOCAL_PROFILE_FILE_NAME = "profile.json";
export const DEFAULT_LOCAL_CONTROL_STORE_FILE_NAME = "control-store.json";
export const DEFAULT_LOCAL_ACTIVITY_LOG_FILE_NAME = "activity.jsonl";
export const DEFAULT_LOCAL_SYNC_STATE_FILE_NAME = "sync-state.json";
export const DEFAULT_LOCAL_KEYRING_DIR_NAME = "keyring";
export const DEFAULT_LOCAL_OBJECT_STORE_DIR_NAME = "objects";
export const DEFAULT_LOCAL_PROFILES_DIR_NAME = "profiles";

export const LocalProfileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "local profile names must be filesystem-safe");

export const LocalProfilePathsSchema = z
  .object({
    install_dir: z.string().min(1),
    profiles_dir: z.string().min(1),
    profile_dir: z.string().min(1),
    profile_config_path: z.string().min(1),
    control_store_path: z.string().min(1),
    keyring_dir: z.string().min(1),
    activity_log_path: z.string().min(1),
    sync_state_path: z.string().min(1),
    object_store_dir: z.string().min(1)
  })
  .strict();

export const LocalProfileEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("living-atlas-local-profile"),
    profile_name: LocalProfileNameSchema,
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    paths: LocalProfilePathsSchema,
    storage: z
      .object({
        control_store: z
          .object({
            kind: z.literal("encrypted-file"),
            path: z.string().min(1)
          })
          .strict(),
        keyring: z
          .object({
            kind: z.literal("local-keyring-directory"),
            path: z.string().min(1),
            unwrapped_key_storage: z.literal("not-stored-in-profile")
          })
          .strict(),
        activity_log: z
          .object({
            kind: z.literal("jsonl-file"),
            path: z.string().min(1)
          })
          .strict(),
        sync_state: z
          .object({
            kind: z.literal("json-file"),
            path: z.string().min(1)
          })
          .strict(),
        object_store: z
          .object({
            kind: z.literal("directory"),
            path: z.string().min(1)
          })
          .strict()
      })
      .strict(),
    secrets: z
      .object({
        local_mcp_token: z.literal("not-stored"),
        control_store_passphrase: z.literal("not-stored"),
        unwrapped_keys: z.literal("not-stored")
      })
      .strict()
  })
  .strict()
  .superRefine((profile, ctx) => {
    const expectedProfileDir = join(profile.paths.profiles_dir, profile.profile_name);
    const expectedProfileConfigPath = join(profile.paths.profile_dir, DEFAULT_LOCAL_PROFILE_FILE_NAME);
    const expectedControlStorePath = join(profile.paths.profile_dir, DEFAULT_LOCAL_CONTROL_STORE_FILE_NAME);
    const expectedKeyringDir = join(profile.paths.profile_dir, DEFAULT_LOCAL_KEYRING_DIR_NAME);
    const expectedActivityLogPath = join(profile.paths.profile_dir, DEFAULT_LOCAL_ACTIVITY_LOG_FILE_NAME);
    const expectedSyncStatePath = join(profile.paths.profile_dir, DEFAULT_LOCAL_SYNC_STATE_FILE_NAME);
    const expectedObjectStoreDir = join(profile.paths.profile_dir, DEFAULT_LOCAL_OBJECT_STORE_DIR_NAME);
    const pathChecks: Array<{
      actual: string;
      expected: string;
      path: (string | number)[];
      message: string;
    }> = [
      {
        actual: profile.paths.profiles_dir,
        expected: join(profile.paths.install_dir, DEFAULT_LOCAL_PROFILES_DIR_NAME),
        path: ["paths", "profiles_dir"],
        message: "profiles_dir must live under install_dir"
      },
      {
        actual: profile.paths.profile_dir,
        expected: expectedProfileDir,
        path: ["paths", "profile_dir"],
        message: "profile_dir must match profile_name"
      },
      {
        actual: profile.paths.profile_config_path,
        expected: expectedProfileConfigPath,
        path: ["paths", "profile_config_path"],
        message: "profile_config_path must live in profile_dir"
      },
      {
        actual: profile.paths.control_store_path,
        expected: expectedControlStorePath,
        path: ["paths", "control_store_path"],
        message: "control_store_path must live in profile_dir"
      },
      {
        actual: profile.paths.keyring_dir,
        expected: expectedKeyringDir,
        path: ["paths", "keyring_dir"],
        message: "keyring_dir must live in profile_dir"
      },
      {
        actual: profile.paths.activity_log_path,
        expected: expectedActivityLogPath,
        path: ["paths", "activity_log_path"],
        message: "activity_log_path must live in profile_dir"
      },
      {
        actual: profile.paths.sync_state_path,
        expected: expectedSyncStatePath,
        path: ["paths", "sync_state_path"],
        message: "sync_state_path must live in profile_dir"
      },
      {
        actual: profile.paths.object_store_dir,
        expected: expectedObjectStoreDir,
        path: ["paths", "object_store_dir"],
        message: "object_store_dir must live in profile_dir"
      },
      {
        actual: profile.storage.control_store.path,
        expected: profile.paths.control_store_path,
        path: ["storage", "control_store", "path"],
        message: "control store storage path must match paths.control_store_path"
      },
      {
        actual: profile.storage.keyring.path,
        expected: profile.paths.keyring_dir,
        path: ["storage", "keyring", "path"],
        message: "keyring storage path must match paths.keyring_dir"
      },
      {
        actual: profile.storage.activity_log.path,
        expected: profile.paths.activity_log_path,
        path: ["storage", "activity_log", "path"],
        message: "activity log storage path must match paths.activity_log_path"
      },
      {
        actual: profile.storage.sync_state.path,
        expected: profile.paths.sync_state_path,
        path: ["storage", "sync_state", "path"],
        message: "sync state storage path must match paths.sync_state_path"
      },
      {
        actual: profile.storage.object_store.path,
        expected: profile.paths.object_store_dir,
        path: ["storage", "object_store", "path"],
        message: "object store storage path must match paths.object_store_dir"
      }
    ];

    for (const check of pathChecks) {
      if (check.actual !== check.expected) {
        ctx.addIssue({
          code: "custom",
          path: check.path,
          message: check.message
        });
      }
    }
  });

export type LocalProfilePaths = z.infer<typeof LocalProfilePathsSchema>;
export type LocalProfileEnvelope = z.infer<typeof LocalProfileEnvelopeSchema>;

export type ResolveLocalProfilePathsOptions = {
  homeDir?: string;
  installDir?: string;
  profileName?: string;
};

export type BuildLocalProfileEnvelopeOptions = ResolveLocalProfilePathsOptions & {
  now?: Date | string;
};

export type CreateLocalProfileOptions = BuildLocalProfileEnvelopeOptions & {
  overwrite?: boolean;
};

export type OpenLocalProfileOptions = ResolveLocalProfilePathsOptions & {
  profileConfigPath?: string;
};

function isoTimestamp(now: Date | string | undefined): string {
  const timestamp = typeof now === "string" ? now : (now ?? new Date()).toISOString();
  return IsoTimestampSchema.parse(timestamp);
}

function profileConfigPathFromOptions(options: OpenLocalProfileOptions = {}): string {
  return options.profileConfigPath ?? resolveLocalProfilePaths(options).profile_config_path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeProfileEnvelope(path: string, profile: LocalProfileEnvelope): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, path);
}

export function defaultLocalInstallDir(homeDir = homedir()): string {
  return resolve(homeDir, DEFAULT_LOCAL_INSTALL_DIR_NAME);
}

export function resolveLocalProfilePaths(options: ResolveLocalProfilePathsOptions = {}): LocalProfilePaths {
  const profileName = LocalProfileNameSchema.parse(options.profileName ?? DEFAULT_LOCAL_PROFILE_NAME);
  const installDir = resolve(options.installDir ?? defaultLocalInstallDir(options.homeDir));
  const profilesDir = join(installDir, DEFAULT_LOCAL_PROFILES_DIR_NAME);
  const profileDir = join(profilesDir, profileName);

  return LocalProfilePathsSchema.parse({
    install_dir: installDir,
    profiles_dir: profilesDir,
    profile_dir: profileDir,
    profile_config_path: join(profileDir, DEFAULT_LOCAL_PROFILE_FILE_NAME),
    control_store_path: join(profileDir, DEFAULT_LOCAL_CONTROL_STORE_FILE_NAME),
    keyring_dir: join(profileDir, DEFAULT_LOCAL_KEYRING_DIR_NAME),
    activity_log_path: join(profileDir, DEFAULT_LOCAL_ACTIVITY_LOG_FILE_NAME),
    sync_state_path: join(profileDir, DEFAULT_LOCAL_SYNC_STATE_FILE_NAME),
    object_store_dir: join(profileDir, DEFAULT_LOCAL_OBJECT_STORE_DIR_NAME)
  });
}

export function buildLocalProfileEnvelope(options: BuildLocalProfileEnvelopeOptions = {}): LocalProfileEnvelope {
  const paths = resolveLocalProfilePaths(options);
  const timestamp = isoTimestamp(options.now);

  return LocalProfileEnvelopeSchema.parse({
    schema_version: 1,
    kind: "living-atlas-local-profile",
    profile_name: LocalProfileNameSchema.parse(options.profileName ?? DEFAULT_LOCAL_PROFILE_NAME),
    created_at: timestamp,
    updated_at: timestamp,
    paths,
    storage: {
      control_store: {
        kind: "encrypted-file",
        path: paths.control_store_path
      },
      keyring: {
        kind: "local-keyring-directory",
        path: paths.keyring_dir,
        unwrapped_key_storage: "not-stored-in-profile"
      },
      activity_log: {
        kind: "jsonl-file",
        path: paths.activity_log_path
      },
      sync_state: {
        kind: "json-file",
        path: paths.sync_state_path
      },
      object_store: {
        kind: "directory",
        path: paths.object_store_dir
      }
    },
    secrets: {
      local_mcp_token: "not-stored",
      control_store_passphrase: "not-stored",
      unwrapped_keys: "not-stored"
    }
  });
}

export async function createLocalProfile(options: CreateLocalProfileOptions = {}): Promise<LocalProfileEnvelope> {
  const profile = buildLocalProfileEnvelope(options);

  if (!options.overwrite && (await pathExists(profile.paths.profile_config_path))) {
    throw new Error(`Local Living Atlas profile already exists: ${profile.paths.profile_config_path}`);
  }

  await mkdir(profile.paths.profile_dir, { recursive: true, mode: 0o700 });
  await mkdir(profile.paths.keyring_dir, { recursive: true, mode: 0o700 });
  await mkdir(profile.paths.object_store_dir, { recursive: true, mode: 0o700 });
  await writeProfileEnvelope(profile.paths.profile_config_path, profile);

  return profile;
}

export async function openLocalProfile(options: OpenLocalProfileOptions = {}): Promise<LocalProfileEnvelope> {
  return LocalProfileEnvelopeSchema.parse(JSON.parse(await readFile(profileConfigPathFromOptions(options), "utf8")));
}

export async function openOrCreateLocalProfile(
  options: CreateLocalProfileOptions = {}
): Promise<LocalProfileEnvelope> {
  const profileConfigPath = resolveLocalProfilePaths(options).profile_config_path;

  if (await pathExists(profileConfigPath)) {
    return openLocalProfile({ profileConfigPath });
  }

  return createLocalProfile(options);
}
