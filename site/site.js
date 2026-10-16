// Copy buttons read their text from the element named in data-copy, or from the pre in the same code block.
for (const button of document.querySelectorAll('[data-copy], .code .copy')) {
  button.addEventListener('click', async () => {
    const source = button.dataset.copy
      ? document.getElementById(button.dataset.copy)
      : [...button.closest('.code').querySelectorAll('pre')].find((pre) => !pre.closest('[hidden]'));
    try {
      await navigator.clipboard.writeText(source.textContent.trim() + '\n');
    } catch {
      // Clipboard access can be refused; selecting the text lets the reader copy it by hand.
      getSelection().selectAllChildren(source);
      return;
    }
    const label = button.querySelector('.label');
    const original = label?.textContent;
    button.classList.add('copied');
    if (label) label.textContent = button.dataset.copied;
    setTimeout(() => {
      button.classList.remove('copied');
      if (label) label.textContent = original;
    }, 1600);
  });
}

// Package manager tabs switch every code block on the page together, so the reader picks once.
const tabButtons = document.querySelectorAll('.tabs button');
for (const button of tabButtons) {
  button.addEventListener('click', () => {
    const manager = button.dataset.tab;
    for (const other of tabButtons) other.setAttribute('aria-selected', String(other.dataset.tab === manager));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== manager;
  });
}
