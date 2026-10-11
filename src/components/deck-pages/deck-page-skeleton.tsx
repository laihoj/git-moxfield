import { Card } from '@/components/ui/card';
import { SidebarLayout } from '@/components/ui/sidebar-layout';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Placeholder for a deck page's content while it loads, shaped like the deck's first page
 * (the deck header and tabs stay visible above it). Owners and share link viewers alike.
 */
export function DeckPageSkeleton() {
  return (
    <SidebarLayout role="status" aria-label="Loading">
      <div className="flex min-w-0 flex-col gap-5">
        <Card>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-3 h-4 w-64 max-w-full" />
          <Skeleton className="mt-2 h-4 w-40" />
          {/* Summary chips wrap like the real ones, so the skeleton fits a phone. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Skeleton className="h-7 w-28 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-36 rounded-full" />
          </div>
        </Card>
        <Card>
          <Skeleton className="h-5 w-40" />
          <div className="mt-5 flex flex-col gap-3">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-5" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card className="min-w-0">
        <Skeleton className="h-5 w-32" />
        <div className="mt-4 flex flex-col gap-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex gap-3">
              <Skeleton className="h-6 w-10" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <span className="sr-only">Loading…</span>
    </SidebarLayout>
  );
}
