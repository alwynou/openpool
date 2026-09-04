/** A user-facing namespace that is independent of any physical provider. */
export interface LogicalBucket {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Logical bucket names are deliberately less restrictive than provider bucket
 * names. They are part of OpenPool's namespace, not an S3 bucket identifier.
 */
export function validateLogicalBucketName(name: string): void {
  if (name.length === 0 || name.length > 128) {
    throw new RangeError('Logical bucket name must be 1-128 characters');
  }

  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f)
    ) {
      throw new RangeError('Logical bucket name contains a control character');
    }
  }
}

export function validateLogicalBucketDescription(
  description: string | null,
): void {
  if (description !== null && description.length > 512) {
    throw new RangeError('Logical bucket description must be at most 512 characters');
  }
}
