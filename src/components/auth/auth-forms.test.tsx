// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { SignInFormState } from '@/app/action-types';

import { ClaimForm } from './claim-form';
import { InviteForm } from './invite-form';
import { LoginLinkForm } from './login-link-form';

type FormAction = (previous: SignInFormState, formData: FormData) => Promise<SignInFormState>;

const actions = vi.hoisted(() => ({
  claimAction: vi.fn<FormAction>(),
  acceptInviteAction: vi.fn<FormAction>(),
  signInWithLinkAction: vi.fn<FormAction>(),
}));
vi.mock('@/app/auth-actions', () => actions);

const INVITE_TOKEN = `gmi_${'e'.repeat(43)}`;
const LINK_TOKEN = `gml_${'f'.repeat(43)}`;

describe('ClaimForm', () => {
  it('sends the setup code and name, and keeps both with the error on the code', async () => {
    const user = userEvent.setup();
    actions.claimAction.mockResolvedValue({
      status: 'error',
      message: 'That is not the setup code. Copy it from the server log and try again.',
      field: 'code',
      values: { code: 'AAAA-BBBB-CCCC', name: 'Jaakko' },
    });
    render(<ClaimForm />);

    expect(screen.getByLabelText('Setup code')).toHaveFocus();
    await user.type(screen.getByLabelText('Setup code'), 'AAAA-BBBB-CCCC');
    await user.type(screen.getByLabelText('Your name'), 'Jaakko');
    await user.click(screen.getByRole('button', { name: 'Become the admin' }));

    const formData = actions.claimAction.mock.calls[0]?.[1];
    expect(formData?.get('code')).toBe('AAAA-BBBB-CCCC');
    expect(formData?.get('name')).toBe('Jaakko');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not the setup code.');
    const code = screen.getByLabelText('Setup code');
    expect(code).toHaveValue('AAAA-BBBB-CCCC');
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveAccessibleDescription(/That is not the setup code/);
    expect(screen.getByLabelText('Your name')).toHaveValue('Jaakko');
    expect(screen.getByLabelText('Your name')).not.toHaveAttribute('aria-invalid');
  });

  it('shows errors that concern no single field in a banner', async () => {
    const user = userEvent.setup();
    actions.claimAction.mockResolvedValue({
      status: 'error',
      message: 'git-moxfield already has an admin. Ask them for an invite.',
      values: { code: 'X', name: 'Y' },
    });
    render(<ClaimForm />);
    await user.type(screen.getByLabelText('Setup code'), 'X');
    await user.type(screen.getByLabelText('Your name'), 'Y');
    await user.click(screen.getByRole('button', { name: 'Become the admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has an admin');
  });
});

describe('InviteForm', () => {
  it('sends the invite token with the chosen name', async () => {
    const user = userEvent.setup();
    actions.acceptInviteAction.mockResolvedValue({
      status: 'error',
      message: 'Names can be at most 40 characters long.',
      field: 'name',
      values: { name: 'A very long name' },
    });
    render(<InviteForm token={INVITE_TOKEN} />);
    await user.type(screen.getByLabelText('Your name'), 'A very long name');
    await user.click(screen.getByRole('button', { name: 'Create my account' }));

    const formData = actions.acceptInviteAction.mock.calls[0]?.[1];
    expect(formData?.get('token')).toBe(INVITE_TOKEN);
    expect(formData?.get('name')).toBe('A very long name');
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 40 characters');
    expect(screen.getByLabelText('Your name')).toHaveValue('A very long name');
  });
});

describe('LoginLinkForm', () => {
  it('uses the link only when the button is pressed', async () => {
    const user = userEvent.setup();
    actions.signInWithLinkAction.mockResolvedValue({
      status: 'error',
      message: 'This link no longer works: it was already used, or it is not valid. Create a new one.',
    });
    render(<LoginLinkForm token={LINK_TOKEN} />);
    expect(actions.signInWithLinkAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign in on this device' }));
    expect(actions.signInWithLinkAction.mock.calls[0]?.[1].get('token')).toBe(LINK_TOKEN);
    expect(await screen.findByRole('alert')).toHaveTextContent('This link no longer works');
  });
});
