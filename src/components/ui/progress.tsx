import * as ProgressPrimitive from '@radix-ui/react-progress';
import type * as React from 'react';
import { cn } from '@/lib/utils';
export function Progress({ className, value, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return <ProgressPrimitive.Root className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)} value={value ?? null} {...props}><ProgressPrimitive.Indicator className={cn('h-full bg-primary transition-transform motion-reduce:transition-none', value == null ? 'progress-indeterminate w-1/3' : 'w-full')} style={value == null ? undefined : { transform: `translateX(-${100 - value}%)` }} /></ProgressPrimitive.Root>;
}
