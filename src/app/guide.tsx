import { useState } from 'react';
import { ArrowDown, ArrowRight, AppWindow, BrainCircuit, Cpu, Database, Download, Files, FileText, HardDrive, Lightbulb, LockKeyhole, MessagesSquare, Repeat2, Ruler, ShieldCheck, Tag, TextSearch, type LucideIcon } from 'lucide-react';
import { publicAsset } from '../lib/utils.ts';
import { NavLink, useRoute } from './navigation.tsx';
import '../duckdb-view.css';
const icons: Record<string, LucideIcon> = { 'arrow-down': ArrowDown, 'arrow-right': ArrowRight, 'app-window': AppWindow, 'brain-circuit': BrainCircuit, cpu: Cpu, database: Database, download: Download, files: Files, 'file-text': FileText, 'hard-drive': HardDrive, lightbulb: Lightbulb, 'lock-keyhole': LockKeyhole, 'messages-square': MessagesSquare, 'repeat-2': Repeat2, ruler: Ruler, 'shield-check': ShieldCheck, tag: Tag, 'text-search': TextSearch };
function GuideIcon({ name }: { name: string }) { const Icon = icons[name] ?? FileText; return <Icon aria-hidden="true" />; }
export function GuidePage() { const route = useRoute(); return (
<section id="duckdb-view" aria-labelledby="duckdb-heading" hidden={route.view !== 'duckdb'}>
<div className="setup-header settings-header">
<h1 id="duckdb-intro-heading" tabIndex={-1}>{"Get started with RAGbox."}</h1>
<NavLink id="duckdb-back" className="setup-back" href="?">{"← Back to chat"}</NavLink>
</div>
<nav className="duckdb-contents" aria-labelledby="duckdb-contents-heading">
<p id="duckdb-contents-heading" className="duckdb-contents-label">{"On this page"}</p>
<ol className="duckdb-contents-list" role="list">
<li>
<a className="duckdb-contents-link" href="#duckdb-guide-heading">
<span className="duckdb-contents-number" aria-hidden="true">{"01"}</span>
<span>
<strong>{"Get started"}</strong>
<small>{"Your first search in four steps"}</small>
</span>
<GuideIcon name="arrow-down" />
</a>
</li>
<li>
<a className="duckdb-contents-link" href="#duckdb-heading">
<span className="duckdb-contents-number" aria-hidden="true">{"02"}</span>
<span>
<strong>{"How it works"}</strong>
<small>{"Explore what happens on your device"}</small>
</span>
<GuideIcon name="arrow-down" />
</a>
<ul className="duckdb-contents-topics" aria-label="How it works topics">
<li>
<a href="#duckdb-ranking-heading">{"Search & ranking"}</a>
</li>
<li>
<a href="#duckdb-local-heading">{"On-device execution"}</a>
</li>
<li>
<a href="#duckdb-files-heading">{"Where data is saved"}</a>
</li>
</ul>
</li>
</ol>
</nav>
<section aria-labelledby="duckdb-intro-heading">
<section className="setup-card duckdb-guide rounded-2xl border bg-card p-6 sm:p-8" aria-labelledby="duckdb-guide-heading">
<header className="duckdb-guide-intro">
<h2 id="duckdb-guide-heading" tabIndex={-1}>{"Your first search, step by step"}</h2>
<p>{"Follow a real NFCorpus search from choosing a collection to reading the original article."}</p>
</header>
<ol className="duckdb-guide-steps" role="list" aria-label="Steps for your first search">
<li className="duckdb-guide-step">
<div className="duckdb-guide-step-heading">
<span className="duckdb-guide-step-number" aria-hidden="true">{"01"}</span>
<h3>{"Prepare your collection and answer model"}</h3>
<span className="duckdb-guide-badge">{"One-time setup"}</span>
</div>
<p>{"In Chat, select "}<strong>{"NFCorpus"}</strong>{" and click "}<strong>{"Prepare NFCorpus"}</strong>{". Wait for "}<strong>{"Ready to search"}</strong>{". The collection and its index are saved in this browser for next time."}</p>
<figure className="duckdb-guide-figure">
<a className="duckdb-guide-screenshot" href={publicAsset("images/how-it-works/01-choose-collection.png")} target="_blank" rel="noopener noreferrer" aria-label="Open full-size screenshot of the collection cards">
<img src={publicAsset("images/how-it-works/01-choose-collection.png")} width="918" height="205" alt="Collection cards: NFCorpus is selected and ready to search; MS MARCO is downloaded and opens automatically when selected." decoding="async" />
</a>
</figure>
<p className="duckdb-guide-note"><strong>Optional answer model:</strong> For cited answers, open <NavLink id="duckdb-guide-model" href="?view=setup#model">Model settings</NavLink>, click <strong>Download model (~1.84 GB)</strong>, and wait until the model is ready. This one-time download needs a supported GPU; the model runs on your device. You can search and read sources without it.</p>
</li>
<li className="duckdb-guide-step">
<div className="duckdb-guide-step-heading">
<span className="duckdb-guide-step-number" aria-hidden="true">{"02"}</span>
<h3>{"Enter your search and send"}</h3>
</div>
<p>{"Open "}<NavLink id="duckdb-guide-chat" href="?">{"Chat"}</NavLink>{", type "}<strong>{"Do nuts lower cholesterol?"}</strong>{", and press "}<kbd>{"Enter"}</kbd>{" or click the "}<strong>{"Send"}</strong>{" arrow."}</p>
<figure className="duckdb-guide-figure">
<a className="duckdb-guide-screenshot" href={publicAsset("images/how-it-works/02-search-collection.png")} target="_blank" rel="noopener noreferrer" aria-label="Open full-size screenshot of entering a search">
<img src={publicAsset("images/how-it-works/02-search-collection.png")} width="923" height="199" alt="The RAGbox search box filled with Do nuts lower cholesterol? and the Send arrow enabled." loading="lazy" decoding="async" />
</a>
</figure>
<p className="duckdb-guide-background">
<GuideIcon name="database" />
<span>
<strong>{"Behind this search:"}</strong>{" DuckDB searches your saved index on your device. BM25 ranks the keyword matches and returns up to ten source documents automatically."}</span>
</p>
</li>
<li className="duckdb-guide-step">
<div className="duckdb-guide-step-heading">
<span className="duckdb-guide-step-number" aria-hidden="true">{"03"}</span>
<h3>{"Open Sources and check the evidence"}</h3>
</div>
<p>{"Expand "}<strong>{"Sources"}</strong>{" beneath the reply to see the matching articles. Open "}<strong>{"Full document text"}</strong>{" on an article to read beyond the excerpt."}</p>
<figure className="duckdb-guide-figure">
<a className="duckdb-guide-screenshot" href={publicAsset("images/how-it-works/03-read-sources.png")} target="_blank" rel="noopener noreferrer" aria-label="Open full-size screenshot of retrieved sources">
<img src={publicAsset("images/how-it-works/03-read-sources.png")} width="927" height="605" alt="Sources for Do nuts lower cholesterol?: ten NFCorpus articles, starting with nut consumption and cardiovascular disease, a pooled analysis of 25 trials on blood lipids, and a walnut and almond crossover study, each with its BM25 score." loading="lazy" decoding="async" />
</a>
<figcaption>{"Actual sources for "}<strong>{"Do nuts lower cholesterol?"}</strong>{" in NFCorpus."}</figcaption>
</figure>
</li>
<li className="duckdb-guide-step">
<div className="duckdb-guide-step-heading">
<span className="duckdb-guide-step-number" aria-hidden="true">{"04"}</span>
<h3>{"Read the cited answer"}</h3>
<span className="duckdb-guide-badge">{"Uses the answer model"}</span>
</div>
<p>{"With the answer model loaded, RAGbox reads the retrieved sources and writes a short answer above them. Every claim ends with a citation such as "}<strong>{"[MED-4301]"}</strong>{"; select one to jump to that article in Sources. Ask a follow-up and RAGbox turns it into a new search with fresh evidence."}</p>
<figure className="duckdb-guide-figure">
<a className="duckdb-guide-screenshot" href={publicAsset("images/how-it-works/04-cited-answer.png")} target="_blank" rel="noopener noreferrer" aria-label="Open full-size screenshot of a cited answer">
<img src={publicAsset("images/how-it-works/04-cited-answer.png")} width="927" height="282" alt="RAGbox answers Do nuts lower cholesterol? in a short paragraph with citations to MED-4301, MED-2381, MED-4706 and MED-4289, noting that not all lipid measures show consistent benefits." loading="lazy" decoding="async" />
</a>
<figcaption>{"The answer to "}<strong>{"Do nuts lower cholesterol?"}</strong>{", citing the sources from step 3."}</figcaption>
</figure>
</li>
</ol>
</section>
</section>
<div className="setup-header settings-header">
<h1 id="duckdb-heading" tabIndex={-1}>{"How it works"}</h1>
</div>
<section className="setup-card duckdb-explainer rounded-2xl border bg-card p-6 sm:p-8" aria-labelledby="duckdb-ranking-heading">
<div className="duckdb-section-heading">
<span className="duckdb-heading-icon">
<GuideIcon name="text-search" />
</span>
<h2 id="duckdb-ranking-heading" tabIndex={-1}>{"A question becomes keywords."}</h2>
</div>
<SearchDemo />
<p>
<a href="https://duckdb.org/docs/current/core_extensions/full_text_search" target="_blank" rel="noopener noreferrer">{"BM25"}</a>{", DuckDB’s full-text ranking method, weighs:"}</p>
<ul className="duckdb-ranking-factors" aria-label="BM25 ranking factors">
<li>
<GuideIcon name="tag" />
<div>
<h3>{"Word rarity"}</h3>
<p>{"Distinctive terms carry more weight."}</p>
</div>
</li>
<li>
<GuideIcon name="repeat-2" />
<div>
<h3>{"Word frequency"}</h3>
<p>{"Repeated matches help, with diminishing returns."}</p>
</div>
</li>
<li>
<GuideIcon name="ruler" />
<div>
<h3>{"Document length"}</h3>
<p>{"Length is factored into the score."}</p>
</div>
</li>
</ul>
<p>{"Scores measure relevance to a query, not factual accuracy."}</p>
<details className="duckdb-query">
<summary>{"NFCorpus search SQL"}</summary>
<pre>
<code>{"SELECT id, title, text,\n       fts_main_nfcorpus.match_bm25(id, ?) AS score\nFROM nfcorpus\nWHERE score IS NOT NULL\nORDER BY score DESC, id\nLIMIT 10;"}</code>
</pre>
<p>{"The "}<code>{"?"}</code>{" is a bound parameter containing the normalized search text."}</p>
</details>
</section>
<section className="setup-card duckdb-explainer rounded-2xl border bg-card p-6 sm:p-8" aria-labelledby="duckdb-local-heading">
<div className="duckdb-section-heading">
<span className="duckdb-heading-icon">
<GuideIcon name="cpu" />
</span>
<h2 id="duckdb-local-heading" tabIndex={-1}>{"How it runs on your device"}</h2>
</div>
<p>{"A "}<a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers" target="_blank" rel="noopener noreferrer">{"web worker"}</a>{" runs code in the background. The chat page sends work to these workers and displays their results, keeping the interface responsive."}</p>
<figure className="duckdb-execution" aria-label="Local execution: chat exchanges messages with a DuckDB worker on the CPU and a model worker on the GPU">
<div className="duckdb-browser-boundary">
<div className="duckdb-browser-label">
<GuideIcon name="app-window" />{"Your browser"}</div>
<div className="duckdb-execution-workspace">
<div className="duckdb-chat-node">
<GuideIcon name="messages-square" />
<h3>{"Chat page"}</h3>
<p>{"Coordinates work and displays results."}</p>
</div>
<div className="duckdb-worker-lanes">
<div className="duckdb-worker-lane">
<div className="duckdb-worker-route">
<div className="duckdb-route-out">
<span>
<small>{"From chat: "}</small>{"SQL query"}</span>
<svg viewBox="0 0 120 12" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
<path d="M0 6H120m-5-5 5 5-5 5" vector-effect="non-scaling-stroke">
</path>
</svg>
</div>
<div className="duckdb-route-in">
<span>
<small>{"To chat: "}</small>{"Sources"}</span>
<svg viewBox="0 0 120 12" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
<path d="M120 6H0m5-5-5 5 5 5" vector-effect="non-scaling-stroke">
</path>
</svg>
</div>
</div>
<div className="duckdb-worker-node">
<div className="duckdb-worker-heading">
<GuideIcon name="database" />
<h3>{"DuckDB worker"}</h3>
<span className="duckdb-hardware">{"CPU"}</span>
</div>
<p>
<a href="https://duckdb.org/docs/current/clients/wasm/overview" target="_blank" rel="noopener noreferrer">{"DuckDB-Wasm"}</a>{" is the DuckDB database compiled to "}<a href="https://developer.mozilla.org/en-US/docs/WebAssembly" target="_blank" rel="noopener noreferrer">{"WebAssembly"}</a>{", a code format your browser executes on your device’s CPU."}</p>
<p>{"The worker opens your saved collection and runs the chat’s SQL query against its full-text index. It returns matching documents and relevance scores for the chat to display."}</p>
</div>
</div>
<div className="duckdb-worker-lane">
<div className="duckdb-worker-route">
<div className="duckdb-route-out">
<span>
<small>{"From chat: "}</small>{"Prompt + sources"}</span>
<svg viewBox="0 0 120 12" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
<path d="M0 6H120m-5-5 5 5-5 5" vector-effect="non-scaling-stroke">
</path>
</svg>
</div>
<div className="duckdb-route-in">
<span>
<small>{"To chat: "}</small>{"Answer stream"}</span>
<svg viewBox="0 0 120 12" preserveAspectRatio="none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
<path d="M120 6H0m5-5-5 5 5 5" vector-effect="non-scaling-stroke">
</path>
</svg>
</div>
</div>
<div className="duckdb-worker-node duckdb-model-node">
<div className="duckdb-worker-heading">
<GuideIcon name="brain-circuit" />
<h3>{"Model worker"}</h3>
<span className="duckdb-hardware">{"GPU"}</span>
</div>
<p>
<a href="https://huggingface.co/docs/transformers.js/index" target="_blank" rel="noopener noreferrer">{"Transformers.js"}</a>{" loads the saved language model into memory and converts your question and retrieved sources into tokens: small pieces of text the model processes."}</p>
<p>
<a href="https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html" target="_blank" rel="noopener noreferrer">{"ONNX Runtime"}</a>{" runs the model’s calculations through "}<a href="https://huggingface.co/docs/transformers.js/guides/webgpu" target="_blank" rel="noopener noreferrer">{"WebGPU"}</a>{", which gives the browser access to a compatible GPU. The worker generates an answer from that context and streams the text back to chat."}</p>
</div>
</div>
</div>
</div>
</div>
<figcaption>
<GuideIcon name="shield-check" />{"These messages stay in your browser. No inference server or API key is involved."}</figcaption>
</figure>
<p className="duckdb-network-note">{"The browser downloads engine code, extensions, collections, and model files. Startup may still need network access on later visits."}</p>
</section>
<section className="setup-card duckdb-explainer rounded-2xl border bg-card p-6 sm:p-8" aria-labelledby="duckdb-files-heading">
<div className="duckdb-section-heading">
<span className="duckdb-heading-icon">
<GuideIcon name="hard-drive" />
</span>
<h2 id="duckdb-files-heading" tabIndex={-1}>{"Where data is saved"}</h2>
</div>
<figure className="duckdb-storage-map" aria-labelledby="duckdb-files-heading" aria-describedby="duckdb-storage-caption">
<dl className="duckdb-storage-list">
<div className="duckdb-storage-row">
<dt>
<GuideIcon name="database" />{"Search indexes"}</dt>
<dd className="duckdb-storage-location">{"OPFS"}<small>{"Private database files"}</small>
</dd>
<dd>
<ul className="duckdb-stored-files" aria-label="Index databases">
<li>
<span>{"NFCorpus"}</span>
<code>{"analytics.duckdb"}</code>
<p>{"Imports and indexes 3,633 articles during setup."}</p>
</li>
<li>
<span>{"MS MARCO"}</span>
<code>{"msmarco-prebuilt.duckdb"}</code>
<p>{"Downloads a prebuilt database of about 3.35 GB and opens it read-only."}</p>
</li>
</ul>
</dd>
</div>
<div className="duckdb-storage-row">
<dt>
<GuideIcon name="brain-circuit" />{"Answer model"}</dt>
<dd className="duckdb-storage-location">{"Cache Storage"}</dd>
<dd>{"Model & tokenizer files"}</dd>
</div>
<div className="duckdb-storage-row">
<dt>
<GuideIcon name="messages-square" />{"Conversations"}</dt>
<dd className="duckdb-storage-location">{"IndexedDB"}</dd>
<dd>{"Chats & source snapshots"}</dd>
</div>
</dl>
<figcaption id="duckdb-storage-caption">
<GuideIcon name="lock-keyhole" />{" A different browser profile, host, or port has separate storage. Clearing site data or browser eviction can remove saved data. Keep one RAGbox tab open per site; database files require exclusive access."}</figcaption>
</figure>
</section>
</section>
); }
function SearchDemo() {
 const [query, setQuery] = useState('the solar energy');
 const [changed, setChanged] = useState(false);
 const words: string[] = query.toLowerCase().match(/[a-z]+/g) ?? [];
 const keywords = new Set(words.filter(word => word !== 'the'));
 const documents = ['Solar energy powers homes.', 'Wind energy powers turbines.', 'Rainfall shapes river systems.'];
 const matches = documents.map(text => new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => keywords.has(word))).size);
 return <figure className="duckdb-match-demo" aria-labelledby="duckdb-demo-caption">
 <div className="duckdb-demo-toolbar"><label htmlFor="duckdb-demo-query"><TextSearch aria-hidden="true" />Try a search</label><select id="duckdb-demo-query" value={query} onChange={e => { setQuery(e.target.value); setChanged(true); }} aria-describedby="duckdb-demo-caption"><option>the solar energy</option><option>wind energy</option><option>river</option></select><ArrowRight aria-hidden="true" className="duckdb-token-arrow" /><div className="duckdb-tokens" aria-label="Search keywords">{[...keywords].map(word => <span key={word}>{word}</span>)}</div></div>
 {words.includes('the') && <p className="duckdb-demo-note">The common word “the” is removed.</p>}
 <div className="duckdb-match-labels"><span>Sample documents</span><span>Matching terms</span></div>
 <ul className="duckdb-match-list">{documents.map((text, i) => <li key={text} className="duckdb-match-row" data-matches={matches[i]}><FileText aria-hidden="true" /><p className="duckdb-match-text">{text.split(/(\b[a-z]+\b)/gi).map((part, j) => keywords.has(part.toLowerCase()) ? <mark key={j}>{part}</mark> : part)}</p><div className="duckdb-match-track" aria-hidden="true"><span className="duckdb-match-fill" style={{ width: `${keywords.size ? matches[i] / keywords.size * 100 : 0}%` }} /></div><span className="duckdb-match-count" aria-label={`${matches[i]} of ${keywords.size} query terms matched`}>{matches[i]} / {keywords.size}</span></li>)}</ul>
 <figcaption id="duckdb-demo-caption">Bars count matching terms in these illustrative documents.</figcaption>
 <p role="status" className="sr-only">{changed ? `${[...keywords].join(', ')}: ${matches.filter(Boolean).length} of ${documents.length} sample documents contain a match.` : ''}</p>
 </figure>;
}
