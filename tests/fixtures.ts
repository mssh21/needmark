import type { CodeContext, FeedbackInput } from '../src/shared/types.js';

export function input(): FeedbackInput {
  return {
    comment: ' Move this button up ', author: ' Reviewer ', url: 'http://localhost:5173/products', title: 'Products', capturedAt: '2026-10-04T00:00:00.000Z',
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 100 },
    target: { kind: 'element', text: 'Buy', selector: '#buy', rect: { x: 200, y: 100, width: 100, height: 40 } },
    capture: { method: 'tab', width: 1, height: 1 },
    screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  };
}

export function codeContext(): CodeContext {
  return { elements: [{ tag: 'button', selector: '#buy', text: 'Buy', rect: { x: 1, y: 2, width: 30, height: 20 },
    attributes: { id: 'buy' }, styles: { display: 'block' }, headings: ['Products'], components: ['App', 'Buy'],
    source: { file: 'src/Buy.tsx', line: 7, column: 3, component: 'Buy' }, sourceRelation: 'self' }], truncated: false };
}
