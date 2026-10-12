import clsx from 'clsx';
import type { Route } from 'next';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { ExternalLink, type ExternalLinkProps } from './external-link';
import { Link } from './navigation';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'relative inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55';

/** Colors, border and hover states of each variant (the icon buttons share them). */
export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg shadow-card hover:bg-accent-hover active:bg-accent-hover',
  secondary:
    'border border-border-strong bg-surface text-fg shadow-card hover:border-subtle hover:bg-surface-2 active:bg-surface-3',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  danger: 'bg-remove text-surface shadow-card hover:opacity-90 active:opacity-80',
};

/**
 * Heights follow the touch-target rule: every size is at least 44px tall on small
 * screens (the `sm` size keeps a compact 36px look and extends its hit area with an
 * invisible pseudo-element), and shrinks to desktop proportions from `md` up.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3 text-sm after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] md:h-8 md:after:hidden",
  md: 'h-11 gap-2 px-4 text-sm md:h-10',
  lg: 'h-12 gap-2 px-5 text-base md:h-11',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
}

/** Class names of a button, for elements that must look like one (links, labels). */
export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  block = false,
}: ButtonStyleOptions = {}): string {
  return clsx(BASE, BUTTON_VARIANTS[variant], SIZES[size], block && 'w-full');
}

export interface ButtonProps extends ComponentPropsWithoutRef<'button'>, ButtonStyleOptions {
  /** Shows a spinner, disables the button and marks it busy. */
  loading?: boolean;
  /** Leading icon (a lucide icon element). Replaced by the spinner while loading. */
  icon?: ReactNode;
}

/** The app's button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant,
  size,
  block,
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(buttonClasses({ variant, size, block }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export interface ButtonLinkProps
  extends Omit<ComponentPropsWithoutRef<typeof Link>, 'href' | 'className'>, ButtonStyleOptions {
  href: Route;
  icon?: ReactNode;
  className?: string;
}

/** An internal navigation link styled as a button. */
export function ButtonLink({
  href,
  variant,
  size,
  block,
  icon,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link href={href} className={clsx(buttonClasses({ variant, size, block }), className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}

export interface ExternalButtonLinkProps extends ExternalLinkProps, ButtonStyleOptions {
  icon?: ReactNode;
}

/** A link to another site, styled as a button (see {@link ExternalLink}). */
export function ExternalButtonLink({
  variant,
  size,
  block,
  icon,
  className,
  children,
  ...props
}: ExternalButtonLinkProps) {
  return (
    <ExternalLink className={clsx(buttonClasses({ variant, size, block }), className)} {...props}>
      {icon}
      {children}
    </ExternalLink>
  );
}
