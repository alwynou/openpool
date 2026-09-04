import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { cn, statusTone } from '../lib/utils';
import { useI18n } from '../i18n';

const buttonVariants = cva(
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'border-zinc-950 bg-zinc-950 text-white hover:bg-zinc-800',
        secondary: 'border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100',
        ghost: 'border-transparent bg-transparent text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950',
        danger: 'border-red-200 bg-white text-red-600 hover:bg-red-50',
      },
      size: {
        default: 'min-h-9',
        compact: 'min-h-8 px-2.5 py-1.5 text-xs',
        icon: 'size-9 px-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly size?: 'default' | 'compact' | 'icon';
  readonly busy?: boolean;
}

export function Button({
  children,
  variant,
  size,
  busy = false,
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={busy || disabled}
    >
      {busy ? <CircleNotchIcon className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={cn(
        'flex min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 shadow-xs outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500',
        className,
      )}
    />
  );
});

export const selectClassName =
  'min-h-10 w-full appearance-none rounded-md border border-zinc-200 bg-white px-3 py-2 pr-9 text-sm text-zinc-900 shadow-xs outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium text-zinc-800">
      <span>{label}</span>
      {children}
      {error ? <span className="text-xs font-normal text-red-600">{error}</span> : null}
      {!error && hint ? <span className="text-xs font-normal leading-5 text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function StatusBadge({ value }: { readonly value: string }) {
  const tone = statusTone(value);
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap',
        tone === 'neutral' && 'border-zinc-200 bg-white text-zinc-800',
        tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-700',
        tone === 'danger' && 'border-red-200 bg-red-50 text-red-600',
      )}
    >
      {t(value.replaceAll('_', ' '))}
    </span>
  );
}

export function PageHeader({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-zinc-950 sm:text-[34px]">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{detail}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function ErrorNotice({
  error,
  requestId,
  onRetry,
}: {
  readonly error: string | null;
  readonly requestId?: string | null;
  readonly onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      <WarningIcon className="mt-0.5 size-4 shrink-0" weight="fill" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{error}</p>
        {requestId ? <p className="mt-1 font-mono text-[11px] text-red-600">{t('Request ID: {{id}}', { id: requestId })}</p> : null}
      </div>
      {onRetry ? <Button type="button" variant="secondary" size="compact" onClick={onRetry}>{t('Retry')}</Button> : null}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-zinc-200 px-6 py-14 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-9 place-items-center rounded-full border border-zinc-200 text-zinc-500">
          <InfoIcon className="size-4" aria-hidden />
        </span>
        <h2 className="mt-4 text-sm font-semibold text-zinc-950">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-zinc-500">{detail}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}

export function LoadingState({ rows = 4 }: { readonly rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200" aria-label={t('Loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="flex h-20 items-center gap-6 border-b border-zinc-100 px-5 last:border-0" key={index}>
          <span className="h-4 w-36 animate-pulse-soft rounded bg-zinc-100" />
          <span className="h-4 w-24 animate-pulse-soft rounded bg-zinc-100" />
          <span className="ml-auto h-8 w-20 animate-pulse-soft rounded bg-zinc-100" />
        </div>
      ))}
    </div>
  );
}
