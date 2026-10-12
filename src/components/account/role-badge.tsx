import { Badge } from '@/components/ui/badge';
import { roleLabel } from '@/lib/accounts';
import type { UserRole } from '@/server/auth/types';

/**
 * The role of an account as a badge: shown for admins, who are the exception; with
 * `showMember`, for members too (an invite says which it is for).
 */
export function RoleBadge({ role, showMember = false }: { role: UserRole; showMember?: boolean }) {
  if (role !== 'admin' && !showMember) return null;
  return <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{roleLabel(role)}</Badge>;
}
