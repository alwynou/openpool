import {
  validateLogicalBucketDescription,
  validateLogicalBucketName,
  type LogicalBucket,
} from '@openpool/domain';

import type { AuditLog } from '../ports/auth';
import type {
  Clock,
  IdGenerator,
  LogicalBucketRepository,
} from '../ports/storage';

export type LogicalBucketErrorCode =
  | 'LOGICAL_BUCKET_INVALID_INPUT'
  | 'LOGICAL_BUCKET_ALREADY_EXISTS'
  | 'LOGICAL_BUCKET_NOT_FOUND';

export class LogicalBucketApplicationError extends Error {
  constructor(
    readonly code: LogicalBucketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LogicalBucketApplicationError';
  }
}

export interface CreateLogicalBucketCommand {
  readonly actorId: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface LogicalBucketMutationDependencies {
  readonly buckets: LogicalBucketRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
}

function invalidInput(message: string): LogicalBucketApplicationError {
  return new LogicalBucketApplicationError(
    'LOGICAL_BUCKET_INVALID_INPUT',
    message,
  );
}

function normalizedBucketInput(command: CreateLogicalBucketCommand): {
  readonly name: string;
  readonly description: string | null;
} {
  const name = command.name.trim();
  const description = command.description?.trim() || null;
  try {
    validateLogicalBucketName(name);
    validateLogicalBucketDescription(description);
  } catch {
    throw invalidInput('Logical bucket name or description is invalid');
  }
  return { name, description };
}

export class CreateLogicalBucket {
  constructor(private readonly dependencies: LogicalBucketMutationDependencies) {}

  async execute(command: CreateLogicalBucketCommand): Promise<LogicalBucket> {
    const input = normalizedBucketInput(command);
    const now = this.dependencies.clock.now().toISOString();
    const bucket: LogicalBucket = {
      id: this.dependencies.ids.next(),
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.dependencies.buckets.create(bucket))) {
      throw new LogicalBucketApplicationError(
        'LOGICAL_BUCKET_ALREADY_EXISTS',
        'A logical bucket with this name already exists',
      );
    }
    await this.dependencies.audit.record({
      actorType: 'ADMIN',
      actorId: command.actorId,
      action: 'LOGICAL_BUCKET_CREATED',
      resourceType: 'LOGICAL_BUCKET',
      resourceId: bucket.id,
      createdAt: now,
    });
    return bucket;
  }
}

export class ListLogicalBuckets {
  constructor(
    private readonly buckets: Pick<LogicalBucketRepository, 'list'>,
  ) {}

  execute(): Promise<readonly LogicalBucket[]> {
    return this.buckets.list();
  }
}

export class GetLogicalBucket {
  constructor(
    private readonly buckets: Pick<LogicalBucketRepository, 'findById'>,
  ) {}

  async execute(id: string): Promise<LogicalBucket> {
    const bucket = await this.buckets.findById(id);
    if (!bucket) {
      throw new LogicalBucketApplicationError(
        'LOGICAL_BUCKET_NOT_FOUND',
        'Logical bucket was not found',
      );
    }
    return bucket;
  }
}
