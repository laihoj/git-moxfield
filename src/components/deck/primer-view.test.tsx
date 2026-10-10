// @vitest-environment jsdom
import primerFixture from '@tests/fixtures/moxfield/v1-primer.json';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { moxfieldPrimerToMarkdown } from '@/integrations/moxfield/primer-markup';
import '@/components/test-utils';

import { PrimerView, safePrimerUrl } from './primer-view';

describe('PrimerView', () => {
  it('renders the hostile fixture without executing or embedding any HTML', () => {
    const markdown = moxfieldPrimerToMarkdown(primerFixture.content);
    const { container } = render(<PrimerView markdown={markdown} />);

    // Raw HTML is skipped entirely: no <script> element, and its code is not shown.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain("alert('xss')");

    // The javascript: link is neutralized: its text remains, as plain text without a link.
    const bad = screen.getByText('bad link');
    expect(bad.closest('a')).toBeNull();
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    }

    // Moxfield markup became markdown: panel titles are headings, card references bold.
    expect(screen.getByRole('heading', { name: 'Introduction' })).toBeInTheDocument();
    expect(screen.getByText("Thassa's Oracle").tagName).toBe('STRONG');
  });

  it('never loads images; the alt text links to the image instead', () => {
    const { container } = render(
      <PrimerView markdown={'![Decklist photo](https://example.com/list.png)\n'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: /Decklist photo/ });
    expect(link).toHaveAttribute('href', 'https://example.com/list.png');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('opens external links in a new tab without leaking the opener or the referrer', () => {
    render(<PrimerView markdown={'[Moxfield](https://moxfield.com) and [mail](mailto:a@example.com)\n'} />);
    const link = screen.getByRole('link', { name: 'Moxfield' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:a@example.com');
  });

  it('shifts headings below the page outline', () => {
    render(<PrimerView markdown={'# Title\n\n## Section\n'} />);
    expect(screen.getByRole('heading', { name: 'Title', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Section', level: 4 })).toBeInTheDocument();
  });
});

describe('safePrimerUrl', () => {
  it.each([
    ['https://moxfield.com/decks/x', 'https://moxfield.com/decks/x'],
    ['http://example.com', 'http://example.com/'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
    ['#mulligans', '#mulligans'],
  ])('keeps %s', (input, expected) => {
    expect(safePrimerUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    '/relative/path',
    '//evil.example',
  ])('drops %s', (input) => {
    expect(safePrimerUrl(input)).toBeUndefined();
  });
});
