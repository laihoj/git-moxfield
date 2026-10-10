import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder for deck page content while it loads (the deck header and tabs stay visible). */
export default function DeckLoading() {
  return (
    <div
      className="grid items-start gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
      role="status"
      aria-label="Loading"
    >
      <div className="flex min-w-0 flex-col gap-5">
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card md:p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-3 h-4 w-64 max-w-full" />
          <Skeleton className="mt-2 h-4 w-40" />
          {/* Summary chips wrap like the real ones, so the skeleton fits a phone. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Skeleton className="h-7 w-28 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-36 rounded-full" />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card md:p-5">
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
        </div>
      </div>
      <div className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-card md:p-5">
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
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
