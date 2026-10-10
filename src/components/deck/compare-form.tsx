'use client';

import { ArrowLeftRight, GitCompareArrows } from 'lucide-react';
import { useId, useState } from 'react';

import type { VersionRefDTO } from '@/server/services/types';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { IconButton } from '@/components/ui/icon-button';
import { Form } from '@/components/ui/navigation';
import { versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';

export interface CompareFormProps {
  /** The deck pages the comparison opens within (the owner's or a share link's). */
  scope: DeckScope;
  /** Versions, newest first. */
  versions: readonly VersionRefDTO[];
  /** Offer the current Moxfield deck as a side (owners only; viewers see committed versions). */
  hasWorking: boolean;
  /** Current selections as version refs (`v12`, `working`, `empty`). */
  from: string;
  to: string;
}

const MESSAGE_PREVIEW_LENGTH = 48;

function optionLabel(version: VersionRefDTO): string {
  const message =
    version.message.length > MESSAGE_PREVIEW_LENGTH
      ? `${version.message.slice(0, MESSAGE_PREVIEW_LENGTH - 1).trimEnd()}…`
      : version.message;
  return `${versionLabel(version.sequence)} · ${message}`;
}

/**
 * Picks the two sides of a comparison: the empty deck, the current Moxfield deck (when
 * known) or any version, newest first. Submits as a GET form (`?from=&to=`), so every
 * comparison has a shareable URL.
 */
export function CompareForm({ scope, versions, hasWorking, from, to }: CompareFormProps) {
  const id = useId();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);

  const options = (
    <>
      {hasWorking && <option value="working">Current Moxfield deck</option>}
      {versions.map((version) => (
        <option key={version.commitId} value={versionLabel(version.sequence)}>
          {optionLabel(version)}
        </option>
      ))}
      <option value="empty">Empty deck</option>
    </>
  );

  return (
    <Form
      action={deckRoutes(scope).compare()}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] md:gap-x-2"
    >
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-from`} className="text-sm font-medium text-fg">
          From
        </label>
        <Select
          id={`${id}-from`}
          name="from"
          value={fromValue}
          onChange={(event) => {
            setFromValue(event.target.value);
          }}
        >
          {options}
        </Select>
      </div>
      <IconButton
        label="Swap sides"
        variant="secondary"
        icon={<ArrowLeftRight aria-hidden="true" className="size-4 rotate-90 md:rotate-0" />}
        className="col-start-2 row-span-2 row-start-1 self-center md:row-span-1 md:self-end"
        onClick={() => {
          setFromValue(toValue);
          setToValue(fromValue);
        }}
      />
      <div className="col-start-1 row-start-2 flex min-w-0 flex-col gap-1.5 md:col-start-3 md:row-start-1">
        <label htmlFor={`${id}-to`} className="text-sm font-medium text-fg">
          To
        </label>
        <Select
          id={`${id}-to`}
          name="to"
          value={toValue}
          onChange={(event) => {
            setToValue(event.target.value);
          }}
        >
          {options}
        </Select>
      </div>
      <Button
        type="submit"
        variant="primary"
        icon={<GitCompareArrows aria-hidden="true" className="size-4" />}
        className="col-span-2 row-start-3 md:col-[4/5] md:row-start-1"
      >
        Compare
      </Button>
    </Form>
  );
}
