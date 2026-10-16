// Copy buttons read their text from the element named in data-copy, or from the pre in the same code block.
for (const button of document.querySelectorAll('[data-copy], .code .copy')) {
  button.addEventListener('click', async () => {
    const source = button.dataset.copy
      ? document.getElementById(button.dataset.copy)
      : [...button.closest('.code').querySelectorAll('pre')].find((pre) => !pre.closest('[hidden]'));
    try {
      await navigator.clipboard.writeText(source.textContent.trim() + '\n');
    } catch {
      // Clipboard access can be refused; showing and selecting the text lets the reader copy it by hand.
      source.closest('[hidden]')?.removeAttribute('hidden');
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

// The hero demo replays the review loop as five scenes. Readers who prefer reduced motion get the finished loop as one still frame instead.
const demo = document.querySelector('[data-demo]');
if (demo) {
  const stage = demo.querySelector('.stage');
  const find = (selector) => stage.querySelector(selector);
  const target = find('[data-target]'), draftText = find('[data-type]'), hint = find('[data-hint]'), badge = find('.badge'), cursor = find('.cursor');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let instant = false, visible = true, wake;

  const frame = demo.querySelector('.demo');
  new ResizeObserver(() => demo.style.setProperty('--s', String(frame.clientWidth / 640))).observe(frame);
  // Scenes only advance while the demo is on screen, so a reader scrolling back finds it where they left it.
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) wake?.(); }).observe(demo);

  const wait = (ms) => new Promise((resolve) => (instant ? resolve() : setTimeout(resolve, ms)));
  const whenVisible = () => visible || new Promise((resolve) => { wake = resolve; });
  const state = (name, on = true) => stage.classList.toggle(name, on);
  const count = (value) => { badge.textContent = value; badge.dataset.count = value; };
  // Positions are measured from the scaled stage, so the cursor lands on the same spot at any width.
  const point = async (element) => {
    const box = stage.getBoundingClientRect(), rect = element.getBoundingClientRect(), scale = box.width / 640;
    cursor.style.translate = `${(rect.left + rect.width / 2 - box.left) / scale}px ${(rect.top + rect.height / 2 - box.top) / scale}px`;
    await wait(650);
  };
  const press = async () => { state('press'); await wait(140); state('press', false); };
  const click = async (element) => { await point(element); await press(); };

  const scenes = [
    async () => {
      await click(find('[data-plus]'));
      state('commenting'); hint.textContent = hint.dataset.hint;
      await point(target); state('hover'); await wait(300); await press();
      state('selected'); state('draft'); await wait(350);
      const text = draftText.dataset.type;
      for (let i = 1; i <= text.length; i++) { draftText.textContent = text.slice(0, i); await wait(32); }
      state('typed'); await click(find('[data-save]'));
      state('draft', false); state('hover', false); state('selected', false); state('pinned'); count(1);
      hint.textContent = hint.dataset.saved; await wait(1000);
      state('commenting', false);
    },
    async () => {
      await click(find('[data-list]')); state('list'); await wait(300);
      await click(find('[data-copy]')); state('copied');
    },
    async () => {
      await wait(700); state('list', false); state('copied', false); state('agent-on'); await wait(500);
      await click(find('[data-paste]')); state('pasted'); await wait(500);
      await click(find('[data-send]')); state('sent');
    },
    async () => {
      state('thinking'); await wait(1400);
      state('replied'); state('fixed');
    },
    async () => {
      await wait(1600); state('agent-on', false); await wait(400);
      await click(find('[data-list]')); state('list'); await wait(300);
      await click(find('[data-resolve]')); state('resolved'); count(0);
    },
  ];

  const reset = () => {
    stage.className = 'stage instant';
    draftText.textContent = ''; hint.textContent = ''; count(0);
    cursor.style.translate = '';
  };

  async function play() {
    reset();
    instant = true;
    if (reduced) { for (const scene of scenes) await scene(); return; }
    stage.offsetWidth;
    instant = false; stage.classList.remove('instant');
    for (;;) {
      for (const scene of scenes) { await whenVisible(); await scene(); await wait(600); }
      await wait(1800); state('fade'); await wait(450);
      reset(); state('fade'); stage.offsetWidth;
      stage.classList.remove('instant'); state('fade', false);
    }
  }

  play();
}
