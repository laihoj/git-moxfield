// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/components/test-utils';

import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('shows the title as text inside a page', () => {
    render(<EmptyState title="No versions yet" description="Commit the deck first." />);
    expect(screen.getByText('No versions yet').tagName).toBe('P');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('makes the title the page’s heading when it is the whole page', () => {
    render(<EmptyState title="We couldn’t find that" headingLevel={1} />);
    expect(screen.getByRole('heading', { level: 1, name: 'We couldn’t find that' })).toBeInTheDocument();
  });
});
