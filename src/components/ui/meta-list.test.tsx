// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { metaItemTexts } from '@/components/test-utils';

import { MetaItem, MetaList } from './meta-list';

/** Conditional items, as callers write them. */
function Activity({ edited }: { edited: boolean }) {
  return (
    <MetaList aria-label="Activity">
      {edited && <MetaItem>Moxfield edited 3 hours ago</MetaItem>}
      {!edited && <MetaItem>never shown</MetaItem>}
      <MetaItem>checked 1 min ago</MetaItem>
    </MetaList>
  );
}

describe('MetaList', () => {
  it('renders a labelled list whose items carry a decorative separator each', () => {
    render(<Activity edited />);
    const list = screen.getByRole('list', { name: 'Activity' });
    expect(list).toHaveClass('meta-list');
    expect(metaItemTexts(list)).toEqual(['Moxfield edited 3 hours ago', 'checked 1 min ago']);
    // The separator is CSS-positioned and clipped at line starts; screen readers never hear it.
    const separators = list.querySelectorAll('.meta-separator');
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator).toHaveAttribute('aria-hidden', 'true');
      expect(separator).toHaveTextContent('·');
    }
  });
});
