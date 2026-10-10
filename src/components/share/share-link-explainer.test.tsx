// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/components/test-utils';

import { ShareLinkExplainer } from './share-link-explainer';

describe('ShareLinkExplainer', () => {
  it('tells the owner that people with a link see their name, as it is now', () => {
    render(<ShareLinkExplainer ownerName="Jaakko Laiho" />);
    expect(within(screen.getByRole('list', { name: 'Shown' })).getByText(/Jaakko Laiho/)).toHaveTextContent(
      'Your name, “Jaakko Laiho”, as who shared the deck',
    );
  });

  it('never claims that nothing of the account is shown', () => {
    render(<ShareLinkExplainer ownerName="Aino" />);
    const never = screen.getByRole('list', { name: 'Never shown' });
    expect(never).toHaveTextContent('Uncommitted changes on Moxfield');
    expect(never).toHaveTextContent('Where the deck is on Moxfield');
    expect(never).toHaveTextContent('Your other decks and the rest of your account');
  });
});
