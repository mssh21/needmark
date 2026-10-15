// Comments and replies are untrusted review data, so this renders a small Markdown subset from scratch instead of trusting a parser with raw HTML: every character is escaped first and only the tags produced here reach the page.
// コメントと返信は信頼できないレビューデータなので、生のHTMLを通すパーサーに任せず、Markdownの一部だけを自前で描画する。すべての文字を先にエスケープし、ここで生成したタグだけをページに出す。

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

// Only web and mail links become anchors; javascript:, data: and relative targets stay as text because the comment author controls them.
// コメントの書き手が自由に書けるため、アンカーにするのはWebとメールのリンクだけにし、javascript:・data:・相対パスは文字のまま残す。
function safeUrl(value: string): string | null {
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
const anchor = (href: string, label: string) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?=[^\w]|$)/g, '$1<em>$2</em>');
}

function links(text: string): string {
  let html = '', last = 0;
  // A bare URL stops at non-ASCII text and keeps closing punctuation outside the link, which is how it usually ends a Japanese or English sentence.
  // 裸のURLは非ASCIIの文字で止め、末尾の句読点や閉じ括弧も含めない。日本語や英語の文はそうして終わることが多いため。
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)|https?:\/\/[^\s<>"'`\u0080-\uffff]+/g)) {
    const [whole, label, target] = match, start = match.index!;
    let raw = whole, trailing = '';
    if (label === undefined) { const cut = /[.,;:!?)\]}」』、。]+$/.exec(raw); if (cut) { trailing = cut[0]; raw = raw.slice(0, -trailing.length); } }
    const href = safeUrl(label === undefined ? raw : target!);
    html += emphasis(escapeHtml(text.slice(last, start)));
    html += href ? anchor(href, label === undefined ? escapeHtml(raw) : emphasis(escapeHtml(label))) : emphasis(escapeHtml(raw));
    html += emphasis(escapeHtml(trailing)); last = start + whole.length;
  }
  return html + emphasis(escapeHtml(text.slice(last)));
}

function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, index) => index % 2 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : links(part)).join('');
}

const listItem = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n'), blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const code: string[] = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) code.push(lines[index++]!);
      index++; blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const level = heading[1]!.length <= 2 ? 3 : 4; blocks.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`); index++; continue; }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`); continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = item[2] !== undefined, entries: string[] = [];
      for (let next = listItem.exec(lines[index] ?? ''); next && (next[2] !== undefined) === ordered; next = listItem.exec(lines[index] ?? '')) { entries.push(`<li>${inline(next[3]!)}</li>`); index++; }
      blocks.push(ordered ? `<ol>${entries.join('')}</ol>` : `<ul>${entries.join('')}</ul>`); continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^\s*```/.test(lines[index]!) && !/^(#{1,6})\s/.test(lines[index]!) && !/^\s*>/.test(lines[index]!) && !listItem.test(lines[index]!)) paragraph.push(inline(lines[index++]!));
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('');
}
