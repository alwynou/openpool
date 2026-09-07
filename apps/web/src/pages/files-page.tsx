import { ArrowClockwiseIcon, CopyIcon, DownloadSimpleIcon, FileIcon, LinkSimpleIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import type { ObjectMetadataResponse, ObjectPublicAccessMode } from '@openpool/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { api } from '../api';
import { ConfirmDialog, Dialog } from '../components/dialogs';
import { useI18n } from '../i18n';
import { errorRequestId, errorText, formatBytes, formatDate } from '../lib/utils';
import {
  canRetryObject,
  captureUploadInput,
  retryTargetFromObject,
  uploadFailureCause,
  uploadFailureGuidance,
  retryStepAfterFailure,
  runUploadWorkflow,
  UploadStepError,
  type UploadAttempt,
  type UploadInputSnapshot,
  type UploadRetryTarget,
  type UploadFailureStep,
} from '../lib/upload-workflow';
import { queryKeys, useBuckets } from '../queries';
import { Button, EmptyState, ErrorNotice, Field, Input, LoadingState, PageHeader, selectClassName, StatusBadge } from '../components/ui';

function localDateTimeValue(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isEffectivelyPublic(
  object: ObjectMetadataResponse,
  bucketPublic: boolean,
): boolean {
  if (object.status !== 'READY' || object.publicAccessMode === 'PRIVATE') {
    return false;
  }
  if (object.publicAccessMode === 'INHERIT') return bucketPublic;
  return (
    object.publicAccessExpiresAt === null ||
    Date.parse(object.publicAccessExpiresAt) > Date.now()
  );
}

export function FilesPage() {
  const { locale, t } = useI18n();
  const bucketsQuery = useBuckets();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const buckets = bucketsQuery.data ?? [];
  const requestedBucketId = searchParams.get('bucket') ?? '';
  const bucketId = buckets.some((bucket) => bucket.id === requestedBucketId) ? requestedBucketId : buckets[0]?.id ?? '';
  const objectsQuery = useQuery({ queryKey: queryKeys.objects(bucketId), queryFn: async () => [...await api.listObjects(bucketId)], enabled: Boolean(bucketId) });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [logicalKey, setLogicalKey] = useState('');
  const [retryTarget, setRetryTarget] = useState<UploadRetryTarget | null>(null);
  const [activeAttempt, setActiveAttempt] = useState<UploadAttempt | null>(null);
  const [uploadError, setUploadError] = useState<{ readonly cause: unknown; readonly step: UploadFailureStep } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ObjectMetadataResponse | null>(null);
  const [publicAccessTarget, setPublicAccessTarget] =
    useState<ObjectMetadataResponse | null>(null);
  const [publicAccessMode, setPublicAccessMode] =
    useState<ObjectPublicAccessMode>('INHERIT');
  const [publicAccessExpiry, setPublicAccessExpiry] = useState('');
  const [publicAccessValidationError, setPublicAccessValidationError] =
    useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async (input: {
      readonly snapshot: UploadInputSnapshot;
      readonly mode: 'new' | 'retry' | 'complete';
      readonly target?: UploadRetryTarget;
      readonly attempt?: UploadAttempt;
    }) => {
      return runUploadWorkflow(api, input, setActiveAttempt);
    },
    onSuccess: async (_result, input) => {
      setActiveAttempt(null);
      setRetryTarget(null);
      setUploadError(null);
      setSelectedFile(null);
      setLogicalKey('');
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects(input.snapshot.bucketId) });
      toast.success(t('Upload complete'), { description: t('The file moved directly to the active provider shard.') });
    },
    onError: async (error, input) => {
      const workflowError = error instanceof UploadStepError ? error : null;
      const cause = uploadFailureCause(workflowError?.cause ?? error);
      const nextStep = workflowError ? retryStepAfterFailure(cause, workflowError.step) : 'create';
      const attempt = workflowError?.attempt && nextStep === 'upload'
        ? { ...workflowError.attempt, step: 'upload' as const }
        : workflowError?.attempt;
      if (attempt) {
        setActiveAttempt(attempt);
        setRetryTarget(attempt.target);
      }
      setUploadError({
        cause,
        step: workflowError?.step ?? 'create',
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects(input.snapshot.bucketId) });
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
      toast.success(t('File deleted'));
    },
  });
  const publicAccessMutation = useMutation({
    mutationFn: ({
      object,
      mode,
      expiresAt,
    }: {
      readonly object: ObjectMetadataResponse;
      readonly mode: ObjectPublicAccessMode;
      readonly expiresAt: string | null;
    }) =>
      api.updateObjectPublicAccess(object.id, {
        mode,
        expiresAt,
        expectedUpdatedAt: object.updatedAt,
      }),
    onSuccess: async () => {
      setPublicAccessTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketId) });
      toast.success(t('File public access updated'));
    },
  });

  const isBusy = uploadMutation.isPending;
  const confirmationOnly = retryTarget !== null && activeAttempt?.target.objectId === retryTarget.objectId && activeAttempt.step === 'complete';
  const selectRetryTarget = (object: ObjectMetadataResponse) => {
    if (!canRetryObject(object) || isBusy) return;
    // Re-selecting this row must not discard a transferred session awaiting confirmation.
    if (retryTarget?.objectId === object.id) return;
    const target = retryTargetFromObject(bucketId, object);
    setActiveAttempt(null);
    setRetryTarget(target);
    setLogicalKey(target.logicalKey);
    setUploadError(null);
    setSelectedFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };
  const clearRetryTarget = () => {
    if (isBusy) return;
    setRetryTarget(null);
    setActiveAttempt(null);
    setUploadError(null);
    setLogicalKey('');
    setSelectedFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };
  const editPublicAccess = (object: ObjectMetadataResponse) => {
    setPublicAccessTarget(object);
    setPublicAccessMode(object.publicAccessMode);
    setPublicAccessExpiry(localDateTimeValue(object.publicAccessExpiresAt));
    setPublicAccessValidationError(null);
  };
  const submitPublicAccess = () => {
    if (!publicAccessTarget || publicAccessMutation.isPending) return;
    let expiresAt: string | null = null;
    if (publicAccessMode === 'PUBLIC' && publicAccessExpiry) {
      const parsed = new Date(publicAccessExpiry);
      if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setPublicAccessValidationError(
          t('The public expiry must be a future date and time.'),
        );
        return;
      }
      expiresAt = parsed.toISOString();
    }
    setPublicAccessValidationError(null);
    publicAccessMutation.mutate({
      object: publicAccessTarget,
      mode: publicAccessMode,
      expiresAt,
    });
  };
  const copyPublicUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('Public link copied'));
    } catch {
      toast.error(t('Could not copy the public link. Select it and copy it manually.'));
    }
  };
  const submitUpload = () => {
    if (isBusy || !selectedFile || !bucketId) return;
    const target = retryTarget;
    const snapshot = captureUploadInput(
      target?.bucketId ?? bucketId,
      target?.logicalKey ?? logicalKey,
      selectedFile,
      target ? { preserveLogicalKey: true } : undefined,
    );
    setUploadError(null);
    if (confirmationOnly && target && activeAttempt) {
      uploadMutation.mutate({ snapshot, mode: 'complete', target, attempt: activeAttempt });
      return;
    }
    uploadMutation.mutate({ snapshot, mode: target ? 'retry' : 'new', ...(target ? { target } : {}) });
  };
  const uploadButtonLabel = t(confirmationOnly
    ? 'Retry confirmation'
    : retryTarget
      ? 'Retry upload'
      : 'Upload');

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('Files')}
        detail={t('Upload and manage logical objects while bytes transfer directly between the browser and provider.')}
        action={buckets.length ? <label><span className="sr-only">{t('Logical bucket')}</span><select className={`${selectClassName} min-w-52`} value={bucketId} disabled={isBusy || retryTarget !== null} onChange={(event) => setSearchParams({ bucket: event.target.value })}>{buckets.map((bucket) => <option value={bucket.id} key={bucket.id}>{bucket.name}</option>)}</select></label> : undefined}
      />
      {bucketsQuery.error ? <ErrorNotice error={errorText(bucketsQuery.error)} requestId={errorRequestId(bucketsQuery.error)} onRetry={() => void bucketsQuery.refetch()} /> : null}
      {bucketsQuery.isLoading ? <LoadingState rows={3} /> : null}
      {!bucketsQuery.isLoading && buckets.length === 0 ? <EmptyState title={t('Create a bucket first')} detail={t('Files become available after a logical namespace has an active shard.')} /> : null}
      {buckets.length ? (
        <>
          <section
            className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 transition-colors focus-within:border-zinc-500"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (isBusy || confirmationOnly) return; const file = event.dataTransfer.files[0]; if (file) setSelectedFile(file); }}
          >
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end">
              <div className="flex flex-1 items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md border border-zinc-200 bg-white"><UploadSimpleIcon className="size-5" aria-hidden /></span><div><h2 className="text-sm font-semibold text-zinc-950">{t('Upload a file')}</h2><p className="mt-1 text-xs leading-5 text-zinc-500">{t('Drop a file here or choose one below. The Worker never receives its bytes.')}</p></div></div>
              <div className="grid flex-[1.5] gap-3 sm:grid-cols-[1fr_1.2fr_auto] sm:items-end">
                <label className="grid gap-1.5 text-xs font-medium text-zinc-700">{t('Logical key')}<Input value={logicalKey} disabled={isBusy || retryTarget !== null} onChange={(event) => setLogicalKey(event.target.value)} placeholder={selectedFile?.name ?? 'reports/2026.pdf'} /></label>
                <label className="grid gap-1.5 text-xs font-medium text-zinc-700">{t('File')}<Input ref={fileInput} type="file" disabled={isBusy || confirmationOnly} aria-describedby={confirmationOnly ? 'upload-confirmation-hint' : undefined} onChange={(event) => { if (!isBusy && !confirmationOnly) setSelectedFile(event.target.files?.[0] ?? null); }} /></label>
                <Button type="button" busy={isBusy} disabled={!selectedFile} onClick={submitUpload}>{uploadButtonLabel}</Button>
              </div>
            </div>
            {retryTarget ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800"><span>{t('Retrying {{key}}. The logical key and bucket are fixed for this retry.', { key: retryTarget.logicalKey })}</span><Button type="button" variant="ghost" size="compact" disabled={isBusy} onClick={clearRetryTarget}>{t('Choose a new upload')}</Button></div> : null}
            {retryTarget && !selectedFile ? <p className="mt-3 text-xs text-zinc-500">{t('Select the original or replacement file to continue this pending upload. Browsers cannot restore a file after a reload.')}</p> : null}
            {confirmationOnly ? <p id="upload-confirmation-hint" className="mt-3 text-xs text-zinc-500">{t('File already transferred. Retry confirmation without uploading it again, or choose a new upload.')}</p> : null}
            {uploadError ? <div className="mt-4"><ErrorNotice error={`${errorText(uploadError.cause)} ${uploadFailureGuidance(uploadError.cause, uploadError.step, t)}`} requestId={errorRequestId(uploadError.cause)} /></div> : null}
          </section>

          {objectsQuery.error ? <ErrorNotice error={errorText(objectsQuery.error)} requestId={errorRequestId(objectsQuery.error)} onRetry={() => void objectsQuery.refetch()} /> : null}
          {objectsQuery.isLoading ? <LoadingState rows={5} /> : null}
          {!objectsQuery.isLoading && (objectsQuery.data?.length ?? 0) === 0 ? <EmptyState title={t('This bucket is empty')} detail={t('Upload the first object to this logical namespace.')} /> : null}
          {(objectsQuery.data?.length ?? 0) > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[860px] border-collapse text-left">
                <thead className="bg-zinc-50/70"><tr className="border-b border-zinc-200 text-[11px] font-semibold tracking-[0.08em] text-zinc-500 uppercase"><th className="px-5 py-3.5">{t('File')}</th><th className="px-5 py-3.5">{t('Size')}</th><th className="px-5 py-3.5">{t('Status')}</th><th className="px-5 py-3.5">{t('Public access')}</th><th className="px-5 py-3.5">{t('Updated')}</th><th className="px-5 py-3.5"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
                <tbody>{objectsQuery.data?.map((object) => <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60" key={object.id}><td className="px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-md border border-zinc-200"><FileIcon className="size-4" aria-hidden /></span><div className="min-w-0"><p className="max-w-md truncate text-sm font-medium text-zinc-900">{object.logicalKey}</p><p className="mt-1 text-xs text-zinc-500">{object.contentType}</p></div></div></td><td className="px-5 py-4 text-sm text-zinc-700">{formatBytes(object.sizeBytes)}</td><td className="px-5 py-4"><StatusBadge value={object.status} /></td><td className="px-5 py-4"><StatusBadge value={isEffectivelyPublic(object, buckets.find((bucket) => bucket.id === bucketId)?.publicAccessEnabled ?? false) ? 'PUBLIC' : 'PRIVATE'} /></td><td className="px-5 py-4 text-sm text-zinc-500">{formatDate(object.updatedAt, locale)}</td><td className="px-5 py-4"><div className="flex justify-end gap-1"><Button type="button" size="compact" variant="ghost" disabled={!canRetryObject(object) || isBusy} onClick={() => selectRetryTarget(object)}><ArrowClockwiseIcon className="size-4" aria-hidden />{t('Retry')}</Button><Button type="button" size="icon" variant="ghost" aria-label={t('Manage public access for {{key}}', { key: object.logicalKey })} disabled={object.status !== 'READY'} onClick={() => editPublicAccess(object)}><LinkSimpleIcon className="size-4" aria-hidden /></Button><Button type="button" size="icon" variant="ghost" aria-label={t('Download {{key}}', { key: object.logicalKey })} disabled={object.status !== 'READY'} busy={downloadMutation.isPending && downloadMutation.variables?.id === object.id} onClick={() => downloadMutation.mutate(object)}><DownloadSimpleIcon className="size-4" aria-hidden /></Button><Button type="button" size="icon" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" aria-label={t('Delete {{key}}', { key: object.logicalKey })} disabled={object.status !== 'READY' && object.status !== 'DELETING'} onClick={() => setPendingDelete(object)}><TrashIcon className="size-4" aria-hidden /></Button></div></td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }} title={pendingDelete ? t('Delete {{key}}?', { key: pendingDelete.logicalKey }) : t('Delete file?')} description={t('The object will be deleted from its provider and its reserved capacity released. This action cannot be undone.')} confirmLabel={t('Delete file')} busy={deleteMutation.isPending} onConfirm={() => { if (pendingDelete) deleteMutation.mutate(pendingDelete); }} />
      <Dialog
        open={publicAccessTarget !== null}
        onOpenChange={(open) => {
          if (!open && !publicAccessMutation.isPending) setPublicAccessTarget(null);
        }}
        title={publicAccessTarget ? t('Public access for {{key}}', { key: publicAccessTarget.logicalKey }) : t('Public access')}
        description={t('The stable link redirects to a short-lived provider URL. Object bytes never pass through the Worker.')}
      >
        {publicAccessTarget ? (
          <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); submitPublicAccess(); }}>
            {publicAccessMutation.error ? <ErrorNotice error={errorText(publicAccessMutation.error)} requestId={errorRequestId(publicAccessMutation.error)} /> : null}
            <Field label={t('Access policy')} hint={t('Inherit follows the bucket default. A file override takes precedence.') }>
              <select className={selectClassName} value={publicAccessMode} disabled={publicAccessMutation.isPending} onChange={(event) => { const mode = event.target.value as ObjectPublicAccessMode; setPublicAccessMode(mode); if (mode !== 'PUBLIC') setPublicAccessExpiry(''); setPublicAccessValidationError(null); }}>
                <option value="INHERIT">{t('Inherit bucket policy')}</option>
                <option value="PUBLIC">{t('Public')}</option>
                <option value="PRIVATE">{t('Private')}</option>
              </select>
            </Field>
            <Field label={t('Public until')} hint={t('Optional. Leave blank for no expiry.')} error={publicAccessValidationError ?? undefined}>
              <Input type="datetime-local" value={publicAccessExpiry} disabled={publicAccessMode !== 'PUBLIC' || publicAccessMutation.isPending} onChange={(event) => { setPublicAccessExpiry(event.target.value); setPublicAccessValidationError(null); }} />
            </Field>
            <Field label={t('Stable public link')} hint={t('The link returns 404 while this file is private or expired.')}>
              <div className="flex gap-2">
                <Input value={publicAccessTarget.publicUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
                <Button type="button" variant="secondary" aria-label={t('Copy public link')} onClick={() => void copyPublicUrl(publicAccessTarget.publicUrl)}><CopyIcon className="size-4" aria-hidden />{t('Copy')}</Button>
              </div>
            </Field>
            <div className="flex justify-end gap-2 border-t border-zinc-100 pt-5">
              <Button type="button" variant="secondary" disabled={publicAccessMutation.isPending} onClick={() => setPublicAccessTarget(null)}>{t('Cancel')}</Button>
              <Button type="submit" busy={publicAccessMutation.isPending}>{t('Save public access')}</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
