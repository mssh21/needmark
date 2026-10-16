import { describe, expect, it } from 'vitest';
import { runtimeFramesOf } from './code-context.js';

describe('runtime stack frames', () => {
  it('reads V8 frames in creation order, keeping five unique HTTP(S) frames without credentials or invalid positions', () => {
    const stack = [
      'Error: raw-stack-sentinel',
      '    at jsxDEV (http://127.0.0.1:4192/node_modules/react.js:10:20)',
      '    at RuntimeWidget (http://127.0.0.1:4192/src/Widget.tsx?t=1:12:3)',
      '    at RuntimeWidget (http://127.0.0.1:4192/src/Widget.tsx?t=1:12:3)',
      '    at RuntimeWidget (webpack-internal:///./src/Unsupported.tsx:2:5)',
      '    at RuntimeWidget (file:///private/src/Unsupported.tsx:2:5)',
      '    at RuntimeWidget (http://user:secret@127.0.0.1:4192/private.tsx:2:5)',
      '    at RuntimeWidget (http://127.0.0.1:4192/zero.tsx:0:5)',
      '    at RuntimeWidget (http://127.0.0.1:4192/large.tsx:1000001:5)',
      '    at Third (https://example.test/third.tsx:15:7)',
      '    at Fourth (http://127.0.0.1:4192/fourth.tsx:17:9)',
      '    at Fifth (http://127.0.0.1:4192/fifth.tsx:19:11)',
      '    at Sixth (http://127.0.0.1:4192/sixth.tsx:21:13)',
    ].join('\n');
    expect(runtimeFramesOf(stack)).toEqual([
      { url: 'http://127.0.0.1:4192/node_modules/react.js', line: 10, column: 20 },
      { url: 'http://127.0.0.1:4192/src/Widget.tsx?t=1', line: 12, column: 3, component: 'RuntimeWidget' },
      { url: 'https://example.test/third.tsx', line: 15, column: 7, component: 'Third' },
      { url: 'http://127.0.0.1:4192/fourth.tsx', line: 17, column: 9, component: 'Fourth' },
      { url: 'http://127.0.0.1:4192/fifth.tsx', line: 19, column: 11, component: 'Fifth' },
    ]);
  });

  it('reads JavaScriptCore frames with the same rules as V8 frames', () => {
    const stack = [
      'Error: private-jsc-stack-sentinel',
      '@http://127.0.0.1:4192/node_modules/react_jsx-dev-runtime.js:246:36',
      'PurchaseButton@http://127.0.0.1:4192/src/Purchase.tsx?t=2:12:3',
      'PurchaseButton@http://127.0.0.1:4192/src/Purchase.tsx?t=2:12:3',
      'PurchaseButton@webpack-internal:///src/Unsupported.tsx:2:5',
      'PurchaseButton@file:///private/src/Unsupported.tsx:2:5',
      'PurchaseButton@http://user:secret@127.0.0.1:4192/private.tsx:2:5',
      'PurchaseButton@http://127.0.0.1:4192/zero.tsx:0:5',
      'PurchaseButton@http://127.0.0.1:4192/large.tsx:1000001:5',
      'invalid pseudo function@data:text/javascript,alert(1):1:1',
      'Third@https://example.test/third.tsx:15:7',
      'Fourth@http://127.0.0.1:4192/fourth.tsx:17:9',
      'Fifth@http://127.0.0.1:4192/fifth.tsx:19:11',
      'Sixth@http://127.0.0.1:4192/sixth.tsx:21:13',
    ].join('\n');
    expect(runtimeFramesOf(stack)).toEqual([
      { url: 'http://127.0.0.1:4192/node_modules/react_jsx-dev-runtime.js', line: 246, column: 36 },
      { url: 'http://127.0.0.1:4192/src/Purchase.tsx?t=2', line: 12, column: 3, component: 'PurchaseButton' },
      { url: 'https://example.test/third.tsx', line: 15, column: 7, component: 'Third' },
      { url: 'http://127.0.0.1:4192/fourth.tsx', line: 17, column: 9, component: 'Fourth' },
      { url: 'http://127.0.0.1:4192/fifth.tsx', line: 19, column: 11, component: 'Fifth' },
    ]);
  });

  it('names a component only after the last segment of a capitalised owner', () => {
    const stack = [
      '    at Object.Checkout (http://127.0.0.1:4192/src/Checkout.tsx:3:1)',
      '    at renderWithHooks (http://127.0.0.1:4192/node_modules/react-dom.js:40:2)',
      '    at http://127.0.0.1:4192/src/anonymous.js:5:6',
    ].join('\n');
    expect(runtimeFramesOf(stack)).toEqual([
      { url: 'http://127.0.0.1:4192/src/Checkout.tsx', line: 3, column: 1, component: 'Checkout' },
      { url: 'http://127.0.0.1:4192/node_modules/react-dom.js', line: 40, column: 2 },
      { url: 'http://127.0.0.1:4192/src/anonymous.js', line: 5, column: 6 },
    ]);
  });

  it('stops reading after forty lines of a long stack', () => {
    const filler = Array.from({ length: 40 }, () => '    at <anonymous>');
    expect(runtimeFramesOf([...filler, '    at Late (http://127.0.0.1:4192/src/Late.tsx:1:1)'].join('\n'))).toEqual([]);
  });
});
