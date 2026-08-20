import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs, with the active one held in the URL hash.
 *
 * Deliberate: somebody looking at a broken funnel needs to send a colleague
 * the exact view they are looking at, and a tab kept only in component state
 * cannot be linked to.
 */
interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

export function Tabs({
  defaultValue,
  children,
  className,
}: {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}) {
  const read = React.useCallback(
    () => window.location.hash.replace('#', '') || defaultValue,
    [defaultValue],
  );
  const [value, setValue] = React.useState(read);

  React.useEffect(() => {
    const onHash = () => setValue(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [read]);

  const set = React.useCallback((v: string) => {
    window.location.hash = v;
    setValue(v);
  }, []);

  return (
    <TabsContext.Provider value={{ value, setValue: set }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/**
 * The same trigger, laid out for a vertical rail.
 *
 * Split from TabsTrigger rather than given an `orientation` prop because the
 * two share only their behaviour: full width, left-aligned, and an accent bar
 * on the active item instead of a raised pill.
 */
export function TabsNavItem({
  value,
  icon,
  children,
  badge,
}: {
  value: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: number;
}) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsNavItem must be inside Tabs');
  const active = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'group relative flex w-full items-center gap-3 px-4 py-2.5 text-[0.8125rem] transition-colors',
        active
          ? 'bg-sidebar-active font-medium text-sidebar-text-active'
          : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-hover',
      )}
    >
      {active ? (
        <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
      ) : null}
      <span className={cn('shrink-0', active ? 'text-accent' : '')}>{icon}</span>
      <span className="truncate">{children}</span>
      {badge ? (
        <span className="ml-auto rounded bg-bad px-1.5 text-[10px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * One panel at a time.
 *
 * The tabs are genuinely separate views rather than anchors down a long page.
 * That is the whole point: the previous dashboard scrolled as one document and
 * highlighted whichever section happened to be in view, so reading the funnel
 * quietly moved you to Sales. Nothing here watches the scroll position.
 */
export function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsContent must be inside Tabs');
  if (ctx.value !== value) return null;
  return <div role="tabpanel" className="space-y-5">{children}</div>;
}
