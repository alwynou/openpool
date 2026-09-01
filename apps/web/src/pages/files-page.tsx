import { DownloadSimpleIcon, FileIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import type { ObjectMetadataResponse } from '@openpool/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { api } from '../api';
import { errorRequestId, errorText, formatBytes, formatDate } from '../lib/utils';
import { queryKeys, useBuckets } from '../queries';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Input, LoadingState, PageHeader, selectClassName, StatusBadge } from '../components/ui';

export function FilesPage() {
  const bucketsQuery = useBuckets();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const buckets = bucketsQuery.data ?? [];
  const requestedBucketId = searchParams.get('bucket') ?? '';
  const bucketId = buckets.some((bucket) => bucket.id === requestedBucketId) ? requestedBucketId : buckets[0]?.id ?? '';
  const objectsQuery = useQuery({ queryKey: queryKeys.objects(bucketId), queryFn: async () => [...await api.listObjects(bucketId)], enabled: Boolean(bucketId) });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [logicalKey, setLogicalKey] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ObjectMetadataResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile || !bucketId) throw new Error('Choose a file before uploading.');
      const key = logicalKey.trim() || selectedFile.name;
      const contentType = selectedFile.type || 'application/octet-stream';
      const signed = await api.createUpload(bucketId, key, selectedFile);
      await api.uploadDirect(signed.uploadUrl, selectedFile, contentType);
      return api.completeUpload(signed.objectId, signed.uploadSessionId);
    },
    onSuccess: async () => {
      setSelectedFile(null);
      setLogicalKey('');
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketId) });
      toast.success('Upload complete', { description: 'The file moved directly to the active provider shard.' });
    },
  });
  const downloadMutation = useMutation({
    mutationFn: (object: ObjectMetadataResponse) => api.downloadObject(object.id),
    onSuccess: (signed) => window.open(signed.downloadUrl, '_blank', 'noopener,noreferrer'),
    onError: (error) => toast.error(errorText(error)),
  });
  const deleteMutation = useMutation({
    mutationFn: (object: ObjectMetadataResponse) => api.deleteObject(object.id),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketId) });
      toast.success('File deleted');
    },
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Files"
        detail="Upload and manage logical objects while bytes transfer directly between the browser and provider."
        action={buckets.length ? <label><span className="sr-only">Logical bucket</span><select className={`${selectClassName} min-w-52`} value={bucketId} onChange={(event) => setSearchParams({ bucket: event.target.value })}>{buckets.map((bucket) => <option value={bucket.id} key={bucket.id}>{bucket.name}</option>)}</select></label> : undefined}
      />
      {bucketsQuery.error ? <ErrorNotice error={errorText(bucketsQuery.error)} requestId={errorRequestId(bucketsQuery.error)} onRetry={() => void bucketsQuery.refetch()} /> : null}
      {bucketsQuery.isLoading ? <LoadingState rows={3} /> : null}
      {!bucketsQuery.isLoading && buckets.length === 0 ? <EmptyState title="Create a bucket first" detail="Files become available after a logical namespace has an active shard." /> : null}
      {buckets.length ? (
        <>
          <section
            className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 transition-colors focus-within:border-zinc-500"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) setSelectedFile(file); }}
          >
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end">
              <div className="flex flex-1 items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md border border-zinc-200 bg-white"><UploadSimpleIcon className="size-5" aria-hidden /></span><div><h2 className="text-sm font-semibold text-zinc-950">Upload a file</h2><p className="mt-1 text-xs leading-5 text-zinc-500">Drop a file here or choose one below. The Worker never receives its bytes.</p></div></div>
              <div className="grid flex-[1.5] gap-3 sm:grid-cols-[1fr_1.2fr_auto] sm:items-end">
                <label className="grid gap-1.5 text-xs font-medium text-zinc-700">Logical key<Input value={logicalKey} onChange={(event) => setLogicalKey(event.target.value)} placeholder={selectedFile?.name ?? 'reports/2026.pdf'} /></label>
                <label className="grid gap-1.5 text-xs font-medium text-zinc-700">File<Input ref={fileInput} type="file" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} /></label>
                <Button type="button" busy={uploadMutation.isPending} disabled={!selectedFile} onClick={() => uploadMutation.mutate()}>Upload</Button>
              </div>
            </div>
            {uploadMutation.error ? <div className="mt-4"><ErrorNotice error={errorText(uploadMutation.error)} requestId={errorRequestId(uploadMutation.error)} /></div> : null}
          </section>

          {objectsQuery.error ? <ErrorNotice error={errorText(objectsQuery.error)} requestId={errorRequestId(objectsQuery.error)} onRetry={() => void objectsQuery.refetch()} /> : null}
          {objectsQuery.isLoading ? <LoadingState rows={5} /> : null}
          {!objectsQuery.isLoading && (objectsQuery.data?.length ?? 0) === 0 ? <EmptyState title="This bucket is empty" detail="Upload the first object to this logical namespace." /> : null}
          {(objectsQuery.data?.length ?? 0) > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead className="bg-zinc-50/70"><tr className="border-b border-zinc-200 text-[11px] font-semibold tracking-[0.08em] text-zinc-500 uppercase"><th className="px-5 py-3.5">File</th><th className="px-5 py-3.5">Size</th><th className="px-5 py-3.5">Status</th><th className="px-5 py-3.5">Updated</th><th className="px-5 py-3.5"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{objectsQuery.data?.map((object) => <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60" key={object.id}><td className="px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-md border border-zinc-200"><FileIcon className="size-4" aria-hidden /></span><div className="min-w-0"><p className="max-w-md truncate text-sm font-medium text-zinc-900">{object.logicalKey}</p><p className="mt-1 text-xs text-zinc-500">{object.contentType}</p></div></div></td><td className="px-5 py-4 text-sm text-zinc-700">{formatBytes(object.sizeBytes)}</td><td className="px-5 py-4"><StatusBadge value={object.status} /></td><td className="px-5 py-4 text-sm text-zinc-500">{formatDate(object.updatedAt)}</td><td className="px-5 py-4"><div className="flex justify-end gap-1"><Button type="button" size="icon" variant="ghost" aria-label={`Download ${object.logicalKey}`} disabled={object.status !== 'READY'} busy={downloadMutation.isPending && downloadMutation.variables?.id === object.id} onClick={() => downloadMutation.mutate(object)}><DownloadSimpleIcon className="size-4" aria-hidden /></Button><Button type="button" size="icon" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" aria-label={`Delete ${object.logicalKey}`} disabled={object.status !== 'READY' && object.status !== 'DELETING'} onClick={() => setPendingDelete(object)}><TrashIcon className="size-4" aria-hidden /></Button></div></td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }} title={pendingDelete ? `Delete ${pendingDelete.logicalKey}?` : 'Delete file?'} description="The object will be deleted from its provider and its reserved capacity released. This action cannot be undone." confirmLabel="Delete file" busy={deleteMutation.isPending} onConfirm={() => { if (pendingDelete) deleteMutation.mutate(pendingDelete); }} />
    </div>
  );
}
