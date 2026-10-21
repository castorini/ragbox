import type * as React from 'react';
import { cn } from '@/lib/utils';
export function Card({ className, ...props }: React.ComponentProps<'div'>) { return <div data-slot="card" className={cn('rounded-2xl border bg-card text-card-foreground shadow-sm', className)} {...props} />; }
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) { return <div data-slot="card-header" className={cn('flex flex-col gap-1.5 p-6', className)} {...props} />; }
export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) { return <h2 data-slot="card-title" className={cn('text-lg font-semibold tracking-tight', className)} {...props} />; }
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) { return <div data-slot="card-content" className={cn('px-6 pb-6', className)} {...props} />; }
export function Badge({ className, ...props }: React.ComponentProps<'span'>) { return <span data-slot="badge" className={cn('inline-flex items-center rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-primary', className)} {...props} />; }
export function Alert({ className, ...props }: React.ComponentProps<'div'>) { return <div data-slot="alert" role="status" className={cn('rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900', className)} {...props} />; }
