import clsx from 'clsx';
import { Image as ImageIcon } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Protocols allowed in primer links. Everything else (`javascript:`, `data:`, relative paths) is dropped. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * URL policy for untrusted primer markdown: absolute `http(s)`/`mailto` URLs and
 * in-document anchors (`#section`) only. Returns `undefined` for anything else, which
 * removes the attribute entirely (the link then renders as plain text).
 */
export function safePrimerUrl(url: string): string | undefined {
  const value = url.trim();
  if (/^#[\w-]*$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function PrimerLink({ href, children }: ComponentPropsWithoutRef<'a'>) {
  if (href === undefined || href === '') return <span className="text-fg">{children}</span>;
  if (href.startsWith('#')) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/** Images are never loaded (privacy, CSP): the alt text becomes a link to the image instead. */
function PrimerImage({ src, alt }: ComponentPropsWithoutRef<'img'>) {
  const label: ReactNode = alt !== undefined && alt.trim() !== '' ? alt : 'Image';
  const href = typeof src === 'string' && src !== '' && !src.startsWith('#') ? src : undefined;
  const content = (
    <>
      <ImageIcon aria-hidden="true" className="inline size-3.5 align-[-2px]" /> {label}
    </>
  );
  if (href === undefined) return <span className="primer-image">{content}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="primer-image">
      {content}
      <span className="sr-only"> (image, opens in a new tab)</span>
    </a>
  );
}

/** Primer headings sit below the page's own h1/h2, so their levels are shifted down by two. */
const COMPONENTS: Components = {
  a: PrimerLink,
  img: PrimerImage,
  h1: ({ children }) => <h3 data-level="1">{children}</h3>,
  h2: ({ children }) => <h4 data-level="2">{children}</h4>,
  h3: ({ children }) => <h5 data-level="3">{children}</h5>,
  h4: ({ children }) => <h6 data-level="4">{children}</h6>,
  h5: ({ children }) => <h6 data-level="5">{children}</h6>,
  h6: ({ children }) => <h6 data-level="6">{children}</h6>,
  table: ({ children }) => (
    <div className="primer-table">
      <table>{children}</table>
    </div>
  ),
};

export interface PrimerViewProps {
  /**
   * Portable markdown (already converted from Moxfield markup with
   * `services.primerToMarkdown`). Untrusted.
   */
  markdown: string;
  className?: string;
}

/**
 * Renders a primer safely: GitHub-flavored markdown without any raw HTML (`skipHtml`),
 * links restricted to http(s)/mailto and opened with `noopener noreferrer nofollow`,
 * images shown as links instead of being loaded.
 */
export function PrimerView({ markdown, className }: PrimerViewProps) {
  return (
    <div className={clsx('primer', className)}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safePrimerUrl} components={COMPONENTS}>
        {markdown}
      </Markdown>
    </div>
  );
}
