import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from '../components/ui/alert-dialog.tsx';
import { useRuntime } from './context.tsx';
import { errorMessage } from '../errors.ts';
interface Confirmation { title: string; description: string; action(): unknown; label?: string; destructive?: boolean }
const ConfirmationContext = createContext<(request: Confirmation) => void>(() => {});
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const runtime = useRuntime();
  const [pending, setPending] = useState<Confirmation | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  return <ConfirmationContext value={request => { trigger.current = document.activeElement as HTMLElement; setPending(request); }}>
    {children}
    <AlertDialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}>
      <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); if (trigger.current?.isConnected && !trigger.current.matches(':disabled')) trigger.current.focus(); }}>
        <AlertDialogTitle className="text-lg font-semibold">{pending?.title}</AlertDialogTitle>
        <AlertDialogDescription className="text-sm leading-relaxed text-muted-foreground">{pending?.description}</AlertDialogDescription>
        <div className="flex flex-wrap justify-end gap-2"><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className={pending?.destructive ? 'bg-destructive hover:bg-destructive/90' : ''} onClick={() => {
          const request = pending; setPending(null);
          void Promise.resolve().then(() => request?.action()).catch(error => runtime.status.setState({ phase: 'error', message: errorMessage(error) }));
        }}>{pending?.label ?? 'Continue'}</AlertDialogAction></div>
      </AlertDialogContent>
    </AlertDialog>
  </ConfirmationContext>;
}
export function useConfirm() { return useContext(ConfirmationContext); }
