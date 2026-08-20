import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Gentelella's `x_panel`: a white surface with a hairline ring and a titled
 * header rule, rather than a bordered box. The ring comes from --shadow-card,
 * which is why there is no border class here.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('x-panel', className)} {...props} />
  ),
);
Card.displayName = 'Card';

/** `x_title` — heading on the left, a count or status on the right. */
const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('x-title', className)} {...props} />
);

const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-[0.9375rem] font-semibold tracking-tight', className)} {...props} />
);

const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 py-4', className)} {...props} />
);

/**
 * The caveat under a panel. Not decoration — these carry what a number does
 * not mean, and dropping them is how a dashboard starts lying quietly.
 */
const CardNote = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('mt-4 text-xs leading-relaxed text-subtle', className)} {...props} />
);

export { Card, CardHeader, CardTitle, CardContent, CardNote };
