import type * as React from 'react';
import { cn } from '@/lib/utils';
const field = 'flex w-full rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
export function Input({ className, ...props }: React.ComponentProps<'input'>) { return <input data-slot="input" className={cn(field, 'h-10', className)} {...props} />; }
export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) { return <textarea data-slot="textarea" className={cn(field, 'min-h-10', className)} {...props} />; }
