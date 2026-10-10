'use client';

import { QrCode as QrCodeIcon, RotateCcw } from 'lucide-react';
import { useState, useTransition } from 'react';

import type { IssuedLinkState } from '@/app/action-types';
import { createDeviceLinkAction } from '@/app/account-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { OneTimeLink } from './one-time-link';
import { QrCode } from './qr-code';

/**
 * Account › Sign in on another device: makes a one-time device link (15 minutes) and
 * shows it as a QR code to scan with the other device's camera, and as a link to copy.
 * The link lives only in this component's state.
 */
export function DeviceLinkPanel() {
  const [state, setState] = useState<IssuedLinkState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const create = (): void => {
    startTransition(async () => {
      setState(await createDeviceLinkAction());
    });
  };

  if (state.status !== 'created') {
    return (
      <div className="flex flex-col items-start gap-3">
        {state.status === 'error' && (
          <Alert tone="error" role="alert" className="self-stretch">
            {state.message}
          </Alert>
        )}
        <Button
          variant="primary"
          loading={pending}
          icon={<QrCodeIcon aria-hidden="true" className="size-4" />}
          onClick={create}
        >
          Create a sign-in link
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      {state.qr !== undefined && (
        <figure className="flex shrink-0 flex-col items-center gap-2 self-center sm:self-start">
          <QrCode code={state.qr} label="QR code of the sign-in link" className="size-44" />
          <figcaption className="text-xs text-muted">Scan with the other device’s camera</figcaption>
        </figure>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <OneTimeLink url={state.url} expiresAt={state.expiresAt} subject="Sign-in link" meta="works once">
          Or open this link on the other device. Anyone who opens it first is signed in as you, so only send
          it to yourself.
        </OneTimeLink>
        <div>
          <Button
            variant="ghost"
            size="sm"
            loading={pending}
            icon={<RotateCcw aria-hidden="true" className="size-4" />}
            onClick={create}
          >
            Make a new link
          </Button>
        </div>
      </div>
    </div>
  );
}
