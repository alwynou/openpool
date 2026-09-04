import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { useI18n } from '../i18n';
import { Button } from './ui';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 data-[state=open]:animate-enter" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(680px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 shadow-2xl outline-none data-[state=open]:animate-enter sm:p-7">
          <div className="pr-10">
            <DialogPrimitive.Title className="text-xl font-semibold tracking-tight text-zinc-950">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1.5 text-sm leading-6 text-zinc-500">{description}</DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close className="absolute top-5 right-5 grid size-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400" aria-label={t('Close dialog')}>
            <XIcon className="size-4" aria-hidden />
          </DialogPrimitive.Close>
          <div className="mt-6">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy = false,
  danger = true,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
  readonly danger?: boolean;
}) {
  const { t } = useI18n();
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 data-[state=open]:animate-enter" />
        <AlertDialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-6 shadow-2xl outline-none data-[state=open]:animate-enter">
          <AlertDialogPrimitive.Title className="text-lg font-semibold text-zinc-950">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="mt-2 text-sm leading-6 text-zinc-500">{description}</AlertDialogPrimitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button type="button" variant="secondary">{t('Cancel')}</Button>
            </AlertDialogPrimitive.Cancel>
            <Button type="button" variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
