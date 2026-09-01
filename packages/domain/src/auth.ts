export const administratorStatuses = ['ACTIVE', 'DISABLED'] as const;
export type AdministratorStatus = (typeof administratorStatuses)[number];

export interface Administrator {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly status: AdministratorStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthSession {
  readonly id: string;
  readonly administratorId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}
