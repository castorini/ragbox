import { requiredElement } from './boundaries.ts';
import './duckdb-view.css';

export function setupDuckDBView() {
  const query = requiredElement<HTMLSelectElement>('#duckdb-demo-query');
  const tokens = requiredElement<HTMLElement>('#duckdb-demo-tokens');
  const note = requiredElement<HTMLElement>('#duckdb-demo-note');
  const status = requiredElement<HTMLElement>('#duckdb-demo-status');
  const documents = Array.from(document.querySelectorAll<HTMLElement>('.duckdb-match-row')).map(row => {
    const text = row.querySelector<HTMLElement>('.duckdb-match-text')!;
    return {
      row, text, original: text.textContent ?? '',
      fill: row.querySelector<HTMLElement>('.duckdb-match-fill')!,
      count: row.querySelector<HTMLElement>('.duckdb-match-count')!,
    };
  });

  // An exact-word illustration only; real collection retrieval uses DuckDB's saved analyzer and BM25.
  function render(announce = false) {
    const words: string[] = query.value.toLowerCase().match(/[a-z]+/g) ?? [];
    const keywords = new Set(words.filter(word => word !== 'the'));
    tokens.replaceChildren(...Array.from(keywords, word => {
      const token = document.createElement('span');
      token.textContent = word;
      return token;
    }));
    note.hidden = !words.includes('the');
    let matchingDocuments = 0;
    for (const { row, text, original, fill, count } of documents) {
      const matched = new Set<string>();
      text.replaceChildren(...original.split(/(\b[a-z]+\b)/gi).map(part => {
        if (!keywords.has(part.toLowerCase())) return document.createTextNode(part);
        matched.add(part.toLowerCase());
        const mark = document.createElement('mark');
        mark.textContent = part;
        return mark;
      }));
      row.dataset.matches = String(matched.size);
      fill.style.width = `${keywords.size ? matched.size / keywords.size * 100 : 0}%`;
      count.textContent = `${matched.size} / ${keywords.size}`;
      count.setAttribute('aria-label', `${matched.size} of ${keywords.size} query terms matched`);
      if (matched.size) matchingDocuments++;
    }
    if (announce) status.textContent = `${Array.from(keywords).join(', ')}: ${matchingDocuments} of ${documents.length} sample documents contain a match.`;
  }
  query.onchange = () => render(true);
  render();
}
