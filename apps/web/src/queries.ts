import { useQuery } from '@tanstack/react-query';

import { api } from './api';

export const queryKeys = {
  health: ['health'] as const,
  access: ['access'] as const,
  accounts: ['storage-accounts'] as const,
  buckets: ['logical-buckets'] as const,
  shards: (bucketId: string) => ['storage-shards', bucketId] as const,
  objects: (bucketId: string) => ['objects', bucketId] as const,
  apiKeys: ['api-keys'] as const,
  audit: (actorType: string) => ['audit-logs', actorType] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: async () => [...await api.listAccounts()] });
}

export function useBuckets() {
  return useQuery({ queryKey: queryKeys.buckets, queryFn: async () => [...await api.listBuckets()] });
}

export function useApiKeys() {
  return useQuery({ queryKey: queryKeys.apiKeys, queryFn: async () => [...await api.listApiKeys()] });
}
