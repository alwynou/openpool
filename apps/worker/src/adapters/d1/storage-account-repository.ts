import type {
  AuditLogEntry,
  CredentialEnvelope,
  ManagedStorageAccountRepository,
  StorageAccountConfigurationRepository,
  StorageAccountReferenceRepository,
  StorageAccountRecord,
} from '@openpool/application';
import type { D1AuditOutboxRepository } from './audit-outbox-repository';
import type {
  CapacityAccuracy,
  ProviderCapabilities,
  ProviderConfig,
  ProviderKind,
  StorageAccount,
  StorageAccountStatus,
  StorageHealthStatus,
} from '@openpool/domain';

interface StorageAccountRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly provider: unknown;
  readonly status: unknown;
  readonly priority: unknown;
  readonly write_enabled: unknown;
  readonly capacity_bytes: unknown;
  readonly used_bytes: unknown;
  readonly provider_config: unknown;
  readonly credential_envelope: unknown;
  readonly last_health_status: unknown;
  readonly last_health_checked_at: unknown;
  readonly capabilities: unknown;
  readonly capacity_accuracy: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const providers = new Set<ProviderKind>(['r2', 'b2', 's3']);
const statuses = new Set<StorageAccountStatus>([
  'VERIFYING',
  'ACTIVE',
  'DRAINING',
  'READ_ONLY',
  'REMOVED',
]);
const healthStatuses = new Set<StorageHealthStatus>([
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY',
]);
const capacityAccuracies = new Set<CapacityAccuracy>([
  'EXACT',
  'ESTIMATED',
  'CONFIGURED',
  'UNKNOWN',
]);

const capabilityNames = [
  'presignedUpload',
  'presignedDownload',
  'headObject',
  'deleteObject',
  'bucketProbe',
  'usageProbe',
] as const satisfies readonly (keyof ProviderCapabilities)[];

const envelopeNames = [
  'version',
  'algorithm',
  'keyId',
  'iv',
  'ciphertext',
] as const;

const selectColumns = `
  SELECT id, name, provider, status, priority, write_enabled,
         capacity_bytes, used_bytes, provider_config, credential_envelope,
         last_health_status, last_health_checked_at, capabilities,
         capacity_accuracy, created_at, updated_at
  FROM storage_accounts`;

function failClosed(field: string): never {
  throw new Error(`Invalid storage account ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') failClosed(field);
  try {
    return JSON.parse(value);
  } catch {
    failClosed(field);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failClosed(field);
  }
}

function parseProviderConfig(value: unknown): ProviderConfig {
  const parsed = parseJson(value, 'provider_config');
  if (!isRecord(parsed)) failClosed('provider_config');
  const config: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean' &&
      item !== null
    ) {
      failClosed('provider_config');
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      failClosed('provider_config');
    }
    config[key] = item;
  }
  return config;
}

function parseCapabilities(value: unknown): ProviderCapabilities {
  const parsed = parseJson(value, 'capabilities');
  if (!isRecord(parsed)) failClosed('capabilities');
  exactKeys(parsed, capabilityNames, 'capabilities');
  for (const key of capabilityNames) {
    if (typeof parsed[key] !== 'boolean') failClosed('capabilities');
  }
  return {
    presignedUpload: parsed.presignedUpload as boolean,
    presignedDownload: parsed.presignedDownload as boolean,
    headObject: parsed.headObject as boolean,
    deleteObject: parsed.deleteObject as boolean,
    bucketProbe: parsed.bucketProbe as boolean,
    usageProbe: parsed.usageProbe as boolean,
  };
}

function parseCredentialEnvelope(value: unknown): CredentialEnvelope {
  const parsed = parseJson(value, 'credential_envelope');
  if (!isRecord(parsed)) failClosed('credential_envelope');
  exactKeys(parsed, envelopeNames, 'credential_envelope');
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== 'AES-256-GCM' ||
    typeof parsed.keyId !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string' ||
    parsed.keyId.length === 0 ||
    parsed.iv.length === 0 ||
    parsed.ciphertext.length === 0
  ) {
    failClosed('credential_envelope');
  }
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    keyId: parsed.keyId,
    iv: parsed.iv,
    ciphertext: parsed.ciphertext,
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') failClosed(field);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) failClosed(field);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) failClosed(field);
  return value === 1;
}

function nullableText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') failClosed(field);
  return value;
}

function oneOf<T extends string>(value: unknown, values: Set<T>, field: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) failClosed(field);
  return value as T;
}

function mapStorageAccount(row: StorageAccountRow): StorageAccountRecord {
  const lastHealthStatus =
    row.last_health_status === null
      ? 'UNKNOWN'
      : oneOf(row.last_health_status, healthStatuses, 'last_health_status');
  const status = oneOf(row.status, statuses, 'status');
  const writeEnabled = flag(row.write_enabled, 'write_enabled');
  const capacityBytes = integer(row.capacity_bytes, 'capacity_bytes');
  const usedBytes = integer(row.used_bytes, 'used_bytes');
  if (
    capacityBytes < 0 ||
    usedBytes < 0 ||
    usedBytes > capacityBytes ||
    (writeEnabled && status !== 'ACTIVE')
  ) {
    failClosed('state');
  }
  return {
    id: text(row.id, 'id'),
    name: text(row.name, 'name'),
    provider: oneOf(row.provider, providers, 'provider'),
    status,
    priority: integer(row.priority, 'priority'),
    writeEnabled,
    capacityBytes,
    usedBytes,
    healthStatus: lastHealthStatus,
    capacityAccuracy: oneOf(
      row.capacity_accuracy,
      capacityAccuracies,
      'capacity_accuracy',
    ),
    providerConfig: parseProviderConfig(row.provider_config),
    capabilities: parseCapabilities(row.capabilities),
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
    lastHealthCheckedAt: nullableText(
      row.last_health_checked_at,
      'last_health_checked_at',
    ),
    credentialEnvelope: parseCredentialEnvelope(row.credential_envelope),
  };
}

function encodeJson(value: unknown, field: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) failClosed(field);
    return encoded;
  } catch {
    failClosed(field);
  }
}

function validateEnvelope(value: CredentialEnvelope): void {
  parseCredentialEnvelope(encodeJson(value, 'credential_envelope'));
}

function validateCapabilities(value: ProviderCapabilities): void {
  parseCapabilities(encodeJson(value, 'capabilities'));
}

function validateProviderConfig(value: ProviderConfig): void {
  parseProviderConfig(encodeJson(value, 'provider_config'));
}

function accountBindings(account: StorageAccount): readonly unknown[] {
  validateProviderConfig(account.providerConfig);
  validateCapabilities(account.capabilities);
  if (
    !Number.isSafeInteger(account.priority) ||
    !Number.isSafeInteger(account.capacityBytes) ||
    account.capacityBytes < 0 ||
    !Number.isSafeInteger(account.usedBytes) ||
    account.usedBytes < 0 ||
    account.usedBytes > account.capacityBytes ||
    (account.writeEnabled && account.status !== 'ACTIVE')
  ) {
    failClosed('state');
  }
  return [
    account.id,
    account.name,
    account.provider,
    account.status,
    account.priority,
    account.writeEnabled ? 1 : 0,
    account.capacityBytes,
    account.usedBytes,
    JSON.stringify(account.providerConfig),
    account.healthStatus,
    account.lastHealthCheckedAt,
    JSON.stringify(account.capabilities),
    account.capacityAccuracy,
    account.createdAt,
    account.updatedAt,
  ];
}

/** D1 adapter for managed storage account metadata and encrypted credentials. */
export class D1StorageAccountRepository
  implements
    ManagedStorageAccountRepository,
    StorageAccountConfigurationRepository,
    StorageAccountReferenceRepository
{
  constructor(
    private readonly db: D1Database,
    private readonly auditOutbox?: Pick<
      D1AuditOutboxRepository,
      'statement' | 'assertPreviousChanges'
    >,
  ) {}

  private async write(
    statement: D1PreparedStatement,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    if (!this.auditOutbox) {
      throw new Error('Storage account mutation requires an audit outbox');
    }
    try {
      const results = await this.db.batch([
        statement,
        this.auditOutbox.assertPreviousChanges(),
        this.auditOutbox.statement(audit),
      ]);
      return results[0]?.meta.changes === 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('openpool_audit_outbox_conflict')
      ) {
        return false;
      }
      throw error;
    }
  }

  async create(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    validateEnvelope(credentialEnvelope);
    const bindings = accountBindings(account);
    const statement = this.db
      .prepare(
        `INSERT INTO storage_accounts
         (id, name, provider, status, priority, write_enabled, capacity_bytes,
          used_bytes, provider_config, credential_envelope, last_health_status,
          last_health_checked_at, capabilities, capacity_accuracy, created_at,
          updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .bind(
        ...bindings.slice(0, 9),
        JSON.stringify(credentialEnvelope),
        ...bindings.slice(9),
      );
    return this.write(statement, audit);
  }

  async findById(id: string): Promise<StorageAccountRecord | undefined> {
    const row = await this.db
      .prepare(`${selectColumns} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<StorageAccountRow>();
    return row === null ? undefined : mapStorageAccount(row);
  }

  async list(): Promise<readonly StorageAccountRecord[]> {
    const result = await this.db
      .prepare(`${selectColumns} ORDER BY priority DESC, created_at ASC, id ASC`)
      .all<StorageAccountRow>();
    return result.results.map(mapStorageAccount);
  }

  async listWritable(): Promise<readonly StorageAccountRecord[]> {
    const result = await this.db
      .prepare(
        `${selectColumns}
         WHERE status = 'ACTIVE'
           AND write_enabled = 1
           AND last_health_status = 'HEALTHY'
           AND capacity_accuracy <> 'UNKNOWN'
         ORDER BY priority DESC, created_at ASC, id ASC`,
      )
      .all<StorageAccountRow>();
    return result.results.map(mapStorageAccount);
  }

  async hasBlockingReferences(storageAccountId: string): Promise<boolean> {
    if (!storageAccountId) failClosed('reference.id');
    const row = await this.db
      .prepare(
        `SELECT EXISTS (
           SELECT 1
           FROM storage_shards
           WHERE storage_account_id = ? AND status <> 'RETIRED'
           UNION ALL
           SELECT 1
           FROM object_locations AS location
           JOIN objects AS object ON object.id = location.object_id
           WHERE location.storage_account_id = ? AND (
             EXISTS (SELECT 1 FROM upload_sessions AS session
               WHERE session.location_id = location.id AND session.status = 'EXPIRED')
             OR (object.status <> 'DELETED' AND NOT EXISTS (
               SELECT 1 FROM upload_sessions AS session
               WHERE session.location_id = location.id AND session.status = 'ABORTED'
             ))
           )
         ) AS has_references`,
      )
      .bind(storageAccountId, storageAccountId)
      .first<{ has_references: unknown }>();
    if (
      row === null ||
      (row.has_references !== 0 && row.has_references !== 1)
    ) {
      failClosed('reference.result');
    }
    return row.has_references === 1;
  }

  async update(
    account: StorageAccount,
    expectedStatus: StorageAccountStatus,
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    validateProviderConfig(account.providerConfig);
    validateCapabilities(account.capabilities);
    const statement = this.db
      .prepare(
        `UPDATE storage_accounts
         SET name = ?, provider = ?, status = ?, priority = ?,
             write_enabled = ?, capacity_bytes = ?, used_bytes = ?,
             provider_config = ?, last_health_status = ?,
             last_health_checked_at = ?, capabilities = ?,
             capacity_accuracy = ?, updated_at = ?
         WHERE id = ? AND status = ? AND updated_at = ?`,
      )
      .bind(
        account.name,
        account.provider,
        account.status,
        account.priority,
        account.writeEnabled ? 1 : 0,
        account.capacityBytes,
        account.usedBytes,
        JSON.stringify(account.providerConfig),
        account.healthStatus,
        account.lastHealthCheckedAt,
        JSON.stringify(account.capabilities),
        account.capacityAccuracy,
        account.updatedAt,
        account.id,
        expectedStatus,
        expectedUpdatedAt,
      );
    return this.write(statement, audit);
  }

  async updateVerifyingConfiguration(
    account: StorageAccount,
    credentialEnvelope: CredentialEnvelope,
    expectedUpdatedAt: string,
    audit: AuditLogEntry,
  ): Promise<boolean> {
    validateProviderConfig(account.providerConfig);
    validateEnvelope(credentialEnvelope);
    validateCapabilities(account.capabilities);
    if (
      account.status !== 'VERIFYING' ||
      account.writeEnabled ||
      account.healthStatus !== 'UNKNOWN' ||
      account.lastHealthCheckedAt !== null
    ) {
      failClosed('configuration state');
    }
    const statement = this.db
      .prepare(
        `UPDATE storage_accounts
         SET provider_config = ?, credential_envelope = ?,
             write_enabled = 0, last_health_status = 'UNKNOWN',
             last_health_checked_at = NULL, capabilities = ?, updated_at = ?
         WHERE id = ? AND status = 'VERIFYING' AND updated_at = ?`,
      )
      .bind(
        JSON.stringify(account.providerConfig),
        JSON.stringify(credentialEnvelope),
        JSON.stringify(account.capabilities),
        account.updatedAt,
        account.id,
        expectedUpdatedAt,
      );
    return this.write(statement, audit);
  }
}

/** Explicit alias for callers that want to distinguish this from read-only repositories. */
export const ManagedD1StorageAccountRepository = D1StorageAccountRepository;
