'use client';

import { LogOut, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react';
import { useState, useTransition } from 'react';

import { revokeSessionAction, signOutOtherDevicesAction } from '@/app/account-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { describeSessionOrigin } from '@/lib/accounts';
import { describeDevice, type DeviceKind } from '@/lib/devices';
import { pluralize } from '@/lib/format';
import type { SessionDTO } from '@/server/auth/types';

const DEVICE_ICONS: Record<DeviceKind, typeof Monitor> = {
  phone: Smartphone,
  tablet: Tablet,
  computer: Monitor,
  unknown: MonitorSmartphone,
};

/**
 * The browsers signed in to the account: which browser on which device, how it signed
 * in, when it was last active; this one first and marked. Others can be signed out one by
 * one or all at once.
 */
export function DeviceList({ sessions }: { sessions: readonly SessionDTO[] }) {
  // This device first, then most recently active (the service's order).
  const ordered = [...sessions].sort((a, b) => Number(b.current) - Number(a.current));
  const others = sessions.filter((session) => !session.current).length;
  return (
    <div className="flex flex-col">
      <ul aria-label="Signed-in devices" className="divide-y divide-border">
        {ordered.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ul>
      {others > 0 && (
        <div className="border-t border-border px-4 py-3.5 md:px-5">
          <InlineConfirm
            trigger={{
              label: others === 1 ? 'Sign out the other device' : `Sign out the other ${others} devices`,
              icon: <LogOut aria-hidden="true" className="size-4" />,
              variant: 'secondary',
            }}
            message={`Sign out ${pluralize(others, 'other device')}? ${others === 1 ? 'It needs' : 'They need'} a bookmarklet or a device link to sign in again.`}
            confirmLabel="Sign out"
            onConfirm={async () => {
              const result = await signOutOtherDevicesAction();
              return result.ok ? null : result.message;
            }}
          />
        </div>
      )}
    </div>
  );
}

function DeviceRow({ session }: { session: SessionDTO }) {
  const device = describeDevice(session.userAgent);
  const Icon = DEVICE_ICONS[device.kind];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 md:px-5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-fg">
          <span className="break-words">{device.label}</span>
          {session.current && <Badge tone="accent">This device</Badge>}
        </p>
        <MetaList className="text-xs text-muted">
          <MetaItem>
            {describeSessionOrigin(session.createdVia)} <RelativeTime value={session.createdAt} />
          </MetaItem>
          {!session.current && (
            <MetaItem>
              Active <RelativeTime value={session.lastSeenAt} />
            </MetaItem>
          )}
        </MetaList>
      </div>
      {!session.current && <SignOutDeviceButton session={session} label={device.label} />}
    </li>
  );
}

function SignOutDeviceButton({ session, label }: { session: SessionDTO; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        loading={pending}
        aria-label={`Sign out ${label}`}
        onClick={() => {
          startTransition(async () => {
            const result = await revokeSessionAction(session.id);
            setError(result.ok ? null : result.message);
          });
        }}
      >
        Sign out
      </Button>
      {error !== null && (
        <p role="alert" className="text-xs text-remove">
          {error}
        </p>
      )}
    </div>
  );
}
