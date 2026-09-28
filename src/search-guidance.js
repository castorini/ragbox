export function setupSearchGuidance() {
  const globalStatus = document.querySelector('#status');
  for (const prefix of ['fts', 'marco']) {
    const button = document.querySelector(`#${prefix}-search`);
    const status = document.querySelector(`#${prefix}-status`);
    const help = document.querySelector(`#${prefix}-help`);
    const update = () => {
      help.hidden = !button.disabled;
      if (!button.disabled) { button.removeAttribute('title'); return; }
      const globalText = globalStatus.textContent;
      const localText = status.textContent;
      let instruction;
      if (/Startup failed|^Error:/.test(globalText)) {
        instruction = `Search unavailable. ${globalText} Reload the page to try again.`;
      } else if (/Database closed/.test(globalText)) {
        instruction = 'Search paused: the database is closed. Reload this page, then reopen your saved index before searching.';
      } else if (/Opening database/.test(globalText)) {
        instruction = 'Getting ready: wait for the database to open. Setup controls will become available automatically.';
      } else if (prefix === 'marco' && /Checking for a saved index|Download or reopen|No saved index|cancelled|Unable to complete/.test(localText)) {
        instruction = 'Search is locked until the index is open. First visit: click “Download & open index (3.35 GB)” above and wait for it to finish. Saved indexes open automatically. If that fails, use “Retry opening index”.';
      } else if (/needs a browser/.test(localText)) {
        instruction = localText;
      } else if (/Downloading|Starting index|Download complete|Opening the saved|Loading|Building|Searching/.test(localText)) {
        instruction = `Please wait — ${localText} Search will become available when the operation finishes.`;
      } else {
        instruction = 'Search is temporarily paused while another operation runs. Wait for it to finish; search will become available automatically.';
      }
      help.textContent = instruction;
      button.title = instruction;
    };
    button.setAttribute('aria-describedby', `${prefix}-help ${prefix}-status`);
    const observer = new MutationObserver(update);
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    observer.observe(globalStatus, { childList: true, characterData: true, subtree: true });
    update();
  }
}
