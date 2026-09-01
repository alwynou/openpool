import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import { KeyIcon } from '@phosphor-icons/react/dist/csr/Key';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { AdministratorResponse, HealthResponse } from '@openpool/contracts';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { cn } from '../lib/utils';
import { Button } from './ui';

const navigation = [
  { to: '/overview', label: 'Overview', icon: HouseIcon },
  { to: '/accounts', label: 'Storage accounts', icon: HardDrivesIcon },
  { to: '/buckets', label: 'Buckets & shards', icon: FolderSimpleIcon },
  { to: '/files', label: 'Files', icon: FileIcon },
  { to: '/api-keys', label: 'API keys', icon: KeyIcon },
  { to: '/audit', label: 'Audit log', icon: ListChecksIcon },
] as const;

export function Brand() {
  return (
    <NavLink to="/overview" className="inline-flex items-center gap-2.5 text-lg font-semibold tracking-[-0.035em] text-zinc-950">
      <img src="/openpool-logo.png" alt="" className="size-7 object-contain" aria-hidden />
      <span>OpenPool</span>
    </NavLink>
  );
}

export function AppShell({
  administrator,
  health,
  onLogout,
  logoutBusy,
  children,
}: {
  readonly administrator: AdministratorResponse;
  readonly health: HealthResponse | null;
  readonly onLogout: () => void;
  readonly logoutBusy: boolean;
  readonly children: ReactNode;
}) {
  const location = useLocation();
  const active = navigation.find((item) => location.pathname.startsWith(item.to));

  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-44 flex-col border-r border-zinc-200 bg-white lg:flex">
        <div className="flex h-[70px] items-center border-b border-zinc-100 px-4"><Brand /></div>
        <nav className="grid gap-1 px-2 py-6" aria-label="Main navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                'flex min-h-10 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
                isActive && 'bg-zinc-100 text-zinc-950',
              )}
            >
              <Icon className="size-4 shrink-0" weight="regular" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-zinc-100 p-3">
          <UserMenu administrator={administrator} onLogout={onLogout} logoutBusy={logoutBusy} />
        </div>
      </aside>

      <div className="lg:pl-44">
        <header className="sticky top-0 z-20 flex h-[70px] items-center justify-between border-b border-zinc-200 bg-white/95 px-4 backdrop-blur sm:px-7 lg:px-9">
          <div className="lg:hidden"><Brand /></div>
          <div className="hidden text-sm font-medium text-zinc-500 lg:block">{active?.label ?? 'OpenPool'}</div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 sm:inline-flex">
              {health?.environment?.toUpperCase() ?? 'CONTROL PLANE'}
            </span>
            <Button type="button" variant="ghost" size="icon" aria-label="Notifications">
              <BellIcon className="size-[18px]" aria-hidden />
            </Button>
            <div className="lg:hidden">
              <UserMenu compact administrator={administrator} onLogout={onLogout} logoutBusy={logoutBusy} />
            </div>
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-3 py-2 lg:hidden" aria-label="Mobile navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                'inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-zinc-600',
                isActive && 'bg-zinc-100 text-zinc-950',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <main className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-7 sm:py-10 lg:px-9 lg:py-12">
          <div
            key={location.pathname}
            className="animate-enter"
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function UserMenu({
  administrator,
  onLogout,
  logoutBusy,
  compact = false,
}: {
  readonly administrator: AdministratorResponse;
  readonly onLogout: () => void;
  readonly logoutBusy: boolean;
  readonly compact?: boolean;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-3 rounded-md p-2 text-left outline-none hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400',
            compact && 'w-auto',
          )}
          aria-label="Administrator menu"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-zinc-950 text-xs font-semibold text-white">
            {administrator.username.slice(0, 1).toUpperCase()}
          </span>
          {!compact ? (
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-xs font-semibold text-zinc-950">{administrator.username}</strong>
              <small className="mt-0.5 block truncate text-[11px] text-zinc-500">Administrator</small>
            </span>
          ) : null}
          <CaretDownIcon className="size-3.5 text-zinc-500" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 min-w-48 rounded-md border border-zinc-200 bg-white p-1 shadow-lg outline-none data-[state=open]:animate-enter"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-zinc-500">Signed in as {administrator.username}</DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
          <DropdownMenu.Item
            disabled={logoutBusy}
            onSelect={onLogout}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm text-zinc-700 outline-none hover:bg-zinc-100 focus:bg-zinc-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <SignOutIcon className="size-4" aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
