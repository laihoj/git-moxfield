import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';

/** Decorative loading indicator; pair it with text or `aria-busy` for assistive tech. */
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={clsx('animate-spin', className ?? 'size-4')} />;
}
