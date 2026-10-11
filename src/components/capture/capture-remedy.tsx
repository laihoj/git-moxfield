import { ButtonLink, type ButtonVariant } from '@/components/ui/button';
import { routes } from '@/lib/routes';

/** The two ways out of a refused capture: a new bookmarklet (its key is gone or outdated), or signing in again. */
export type CaptureRemedy = 'new-bookmarklet' | 'sign-in';

/** The button of a {@link CaptureRemedy}, for the actions of an Alert. Signing in comes back to the paste page. */
export function CaptureRemedyAction({
  remedy,
  variant = 'secondary',
}: {
  remedy: CaptureRemedy;
  variant?: ButtonVariant;
}) {
  return remedy === 'new-bookmarklet' ? (
    <ButtonLink href={routes.setup()} variant={variant} size="sm">
      Make a new bookmarklet
    </ButtonLink>
  ) : (
    <ButtonLink href={routes.signIn(routes.capturePaste())} variant={variant} size="sm">
      Sign in
    </ButtonLink>
  );
}
