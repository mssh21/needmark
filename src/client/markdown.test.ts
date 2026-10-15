import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('comment markdown', () => {
  it('escapes HTML everywhere so untrusted text never becomes markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **<b>bold</b>** `<script>` [<i>x</i>](https://example.com)');
    expect(html).not.toMatch(/<img|<b>|<i>|<script/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
    expect(html).toContain('<code>&lt;script&gt;</code>');
  });

  it('turns only web and mail links into anchors that open in a new tab', () => {
    expect(renderMarkdown('[docs](https://example.com/a?b=1&c=2)')).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
    expect(renderMarkdown('see https://example.com/path.')).toBe('<p>see <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>.</p>');
    expect(renderMarkdown('[mail](mailto:a@example.com)')).toContain('href="mailto:a@example.com"');
    for (const unsafe of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](/relative)', '[x](vscode://file/etc/passwd)']) expect(renderMarkdown(unsafe)).not.toContain('<a ');
    expect(renderMarkdown('URLの例：https://example.com/a。続き')).toContain('>https://example.com/a</a>。続き');
  });

  it('renders emphasis, code, headings, quotes, lists and line breaks', () => {
    expect(renderMarkdown('**bold** *em* _em_ ~~gone~~ snake_case_name')).toBe('<p><strong>bold</strong> <em>em</em> <em>em</em> <del>gone</del> snake_case_name</p>');
    expect(renderMarkdown('# Title\n## Sub\n### Small')).toBe('<h3>Title</h3><h3>Sub</h3><h4>Small</h4>');
    expect(renderMarkdown('> quoted **text**\n> more')).toBe('<blockquote><p>quoted <strong>text</strong><br>more</p></blockquote>');
    expect(renderMarkdown('- one\n- two\n\n1. first\n2) second')).toBe('<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
    expect(renderMarkdown('```\nconst a = "<b>";\n```')).toBe('<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(renderMarkdown('first line\nsecond line\n\nnext paragraph')).toBe('<p>first line<br>second line</p><p>next paragraph</p>');
  });
});
