import { useStore } from 'zustand';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button.tsx';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { formatBytes } from '../format.ts';
import { settingsCollectionStatus } from '../lib/presentation.ts';
import { removalDescription, type StorageTarget } from '../services/storage.ts';
import { useRuntime, useResources } from './context.tsx';
import { useConfirm } from './confirmation.tsx';
import { NavLink, useRoute } from './navigation.tsx';
import { collectionInfo, CollectionActions } from './collections.tsx';
import { ModelControls } from './model-controls.tsx';
import type { Corpus } from '../types.ts';
export function SettingsPage() {
  const route = useRoute();
  const unsupported = useResources(s => s.resources.model.phase === 'unsupported');
  const installed = useResources(s => s.resources.model.model?.cache ?? 'checking');
  const installedLabel = { checking: 'Checking installed files…', missing: 'Not installed', incomplete: 'Incomplete install', installed: 'Installed · MiniCPM5-2B', corrupt: 'Invalid model files', unknown: 'Installed files unavailable' }[installed];
  return <section id="setup-view" hidden={route.view !== 'setup'} aria-labelledby="setup-heading" className="space-y-5 py-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 id="setup-heading" tabIndex={-1} className="page-heading">Settings</h1><p className="mt-2 text-sm text-muted-foreground">Collections and the answer model are saved in this browser.</p></div><NavLink href="?" className="text-sm font-semibold text-primary underline underline-offset-4">← Back to chat</NavLink></header>
    <Card><CardHeader><CardTitle>Indexes</CardTitle></CardHeader><CardContent className="divide-y"><CollectionSettings corpus="nfcorpus" /><CollectionSettings corpus="msmarco" /></CardContent></Card>
    <StoragePanel model={false} />
    <Card id="model" tabIndex={-1}><CardHeader><CardTitle>Answer model</CardTitle><p className="text-sm text-muted-foreground">Generate answers with citations from your search results. Runs on your device.</p></CardHeader><CardContent className="space-y-3"><Badge>{installedLabel}</Badge><ModelControls settings />{unsupported && <p className="text-sm text-muted-foreground">This device cannot generate AI answers. Document search remains available.</p>}</CardContent></Card>
    <StoragePanel model />
    <Card><CardHeader><CardTitle>Start over</CardTitle><p className="text-sm text-muted-foreground">Remove index files and the answer model. Conversations are kept.</p></CardHeader><CardContent><DeleteButton target={{ kind: 'all' }}>Delete indexes and model</DeleteButton></CardContent></Card>
    <StorageRecovery />
  </section>;
}
function CollectionSettings({ corpus }: { corpus: Corpus }) {
  const state = useResources(s => s.resources[corpus]);
  const status = settingsCollectionStatus(corpus, state), info = collectionInfo[corpus];
  return <section id={`setup-${corpus}`} tabIndex={-1} className="flex scroll-mt-8 flex-wrap items-start justify-between gap-4 py-5 first:pt-0 last:pb-0" data-phase={state.phase} aria-labelledby={`${corpus}-heading`}>
    <div className="min-w-0 flex-1 basis-60"><div className="flex flex-wrap items-center gap-3"><h3 id={`${corpus}-heading`} className="font-semibold">{info.name}</h3><Badge>{status.label}</Badge></div><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{info.description}</p>{status.detail && <p className="mt-2 text-sm text-muted-foreground" aria-live={corpus === 'msmarco' ? 'off' : 'polite'}>{status.detail}</p>}</div>
    <CollectionActions corpus={corpus} settings />
  </section>;
}
function useDeletionBlocked() {
  const runtime = useRuntime();
  const s = useStore(runtime.storage.state);
  const resourcesBlocked = useResources(s => s.busy || s.shuttingDown || Object.values(s.resources).some(r => ['checking', 'opening', 'preparing', 'downloading', 'loading', 'generating'].includes(r.phase)));
  return { snapshot: s, blocked: resourcesBlocked || !s.initialized || s.stopped || s.deleting || s.refreshing || s.refreshingModel };
}
function DeleteButton({ target, children }: { target: StorageTarget; children: React.ReactNode }) {
  const runtime = useRuntime(), confirm = useConfirm();
  const { snapshot: s, blocked } = useDeletionBlocked();
  const unavailable = target.kind === 'model' ? !s.cacheSupported || !s.modelFiles.length : !s.supported || (target.kind === 'all' ? !s.cacheSupported : !s.files.some(file => file.owned));
  return <Button variant="destructive" size="sm" disabled={blocked || unavailable} onClick={() => confirm({ title: target.kind === 'file' ? `Delete ${target.path}?` : target.kind === 'all' ? 'Delete indexes and model?' : target.kind === 'model' ? 'Delete model?' : 'Delete index data?', description: removalDescription(target), label: 'Delete', destructive: true, action: () => runtime.storage.remove(target) })}><Trash2 aria-hidden="true" />{children}</Button>;
}
function StoragePanel({ model }: { model: boolean }) {
  const runtime = useRuntime();
  const s = useStore(runtime.storage.state);
  const files = model ? s.modelFiles : s.files;
  const owned = s.files.filter(file => file.owned);
  const unknown = model && s.modelFiles.some(file => file.size === null);
  const total = model ? s.modelFiles.reduce((sum, file) => sum + (file.size ?? 0), 0) : owned.reduce((sum, file) => sum + file.size, 0);
  const supported = model ? s.cacheSupported : s.supported;
  const refreshing = model ? s.refreshingModel : s.refreshing;
  const message = model ? s.modelMessage : s.message;
  const summary = `${model ? s.modelFiles.length : owned.length} ${model ? 'cached' : 'app'} file${(model ? s.modelFiles.length : owned.length) === 1 ? '' : 's'} · ${unknown ? 'at least ' : ''}${formatBytes(total)}`;
  return <Card><CardHeader className="flex-row flex-wrap items-start justify-between gap-4"><div className="space-y-1.5"><CardTitle>{model ? 'Model files' : 'Indexes and app files'}</CardTitle><p className="text-sm text-muted-foreground">{supported ? summary : 'Unavailable'}</p><p className="text-sm text-muted-foreground">{model ? 'Deleting stops AI answers. Search indexes are kept.' : 'Deleting removes indexes and saved app files. The answer model is kept.'}</p></div><DeleteButton target={{ kind: model ? 'model' : 'collections' }}>{model ? 'Delete model' : 'Delete index data'}</DeleteButton></CardHeader>
    <CardContent><details id={model ? 'model-management' : 'collection-management'} tabIndex={-1} className="scroll-mt-8"><summary className="py-2 text-sm font-semibold text-primary">Manage saved files</summary><div id={model ? 'model-storage' : undefined} tabIndex={model ? -1 : undefined} className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{summary}</span><Button variant="outline" size="sm" aria-label={model ? 'Refresh model files' : 'Refresh collection files'} disabled={!supported || refreshing || s.deleting || s.stopped} onClick={() => { void (model ? runtime.storage.refreshModels() : runtime.storage.refreshCollections()); }}><RefreshCw className={refreshing ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />Refresh</Button></div>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      {!!files.length && <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-96 text-left text-xs"><caption className="sr-only">{model ? 'Saved model files' : 'Saved index and app files'}</caption><thead className="border-b bg-secondary/40 text-muted-foreground"><tr><th className="p-3 font-semibold">File</th><th className="p-3 font-semibold">Size</th><th className="p-3 font-semibold">{model ? 'Cache' : 'Action'}</th></tr></thead><tbody>{model ? s.modelFiles.map(file => <tr key={`${file.cache}:${file.path}`} className="border-b last:border-0"><td className="max-w-96 p-3 font-mono break-all">{file.path}</td><td className="p-3 whitespace-nowrap">{file.size === null ? 'Unknown' : formatBytes(file.size)}</td><td className="max-w-48 p-3 break-all">{file.cache}</td></tr>) : s.files.map(file => <tr key={file.path} className="border-b last:border-0"><td className="p-3 font-mono break-all">{file.path}</td><td className="p-3 whitespace-nowrap">{formatBytes(file.size)}</td><td className="p-3">{file.owned ? <DeleteButton target={{ kind: 'file', path: file.path }}>Delete {file.path}</DeleteButton> : <span className="text-muted-foreground">Other origin file</span>}</td></tr>)}</tbody></table></div>}
    </div></details></CardContent>
  </Card>;
}
function StorageRecovery() {
  const runtime = useRuntime();
  const recovery = useStore(runtime.storage.state, s => s.recovery);
  const deleting = useStore(runtime.storage.state, s => s.deleting);
  return recovery ? <Alert><p className="mb-2">Reload to recover before trying another storage operation.</p><Button variant="outline" disabled={deleting} onClick={() => runtime.storage.reloadPage()}>Reload to recover</Button></Alert> : null;
}
