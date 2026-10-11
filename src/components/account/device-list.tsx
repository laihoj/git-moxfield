'use client';

import { LogOut, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react';

import { revokeSessionAction, signOutOtherDevicesAction } from '@/app/account-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/field';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { useActionRunner } from '@/components/ui/use-action-runner';
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
      <ItemList label="Signed-in devices">
        {ordered.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ItemList>
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
            onConfirm={() => signOutOtherDevicesAction()}
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
    <ItemRow
      icon={<Icon aria-hidden="true" />}
      title={
        <ItemTitle badges={session.current && <Badge tone="accent">This device</Badge>}>
          {device.label}
        </ItemTitle>
      }
      meta={
        <>
          <MetaItem>
            {describeSessionOrigin(session.createdVia)} <RelativeTime value={session.createdAt} />
          </MetaItem>
          {!session.current && (
            <MetaItem>
              Active <RelativeTime value={session.lastSeenAt} />
            </MetaItem>
          )}
        </>
      }
      actions={!session.current && <SignOutDeviceButton session={session} label={device.label} />}
    />
  );
}

function SignOutDeviceButton({ session, label }: { session: SessionDTO; label: string }) {
  const { pending, error, run } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        loading={pending}
        aria-label={`Sign out ${label}`}
        onClick={() => {
          run(() => revokeSessionAction(session.id));
        }}
      >
        Sign out
      </Button>
      {error !== null && <ErrorText size="xs">{error}</ErrorText>}
    </div>
  );
}
