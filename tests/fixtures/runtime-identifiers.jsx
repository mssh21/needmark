import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function CypressTarget() {
  const button = <button data-cy="cy-checkout">Checkout via Cypress</button>;
  // Retain the native JSX allocation frame in JavaScriptCore as well as V8.
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

function ComponentTarget() {
  const button = <button data-component="InvoiceAction">Open invoice</button>;
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

function CustomTarget() {
  const button = <button data-ticket="NB-42">Review ticket</button>;
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

function UnconfiguredTarget() {
  const button = <button data-experiment="experimental-action">Experimental action</button>;
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

function RuntimeTargets() {
  const [reversed, setReversed] = useState(false);
  const targets = [<CypressTarget key="cy" />, <ComponentTarget key="component" />, <CustomTarget key="custom" />, <UnconfiguredTarget key="experiment" />];
  return <main>
    <button id="reorder" onClick={() => setReversed(!reversed)}>Reorder existing targets</button>
    <section className="targets">{reversed ? [...targets].reverse() : targets}</section>
    {/* EXTRA_TARGET */}
  </main>;
}

if (new URLSearchParams(location.search).has('embedded')) {
  document.body.style.minHeight = '800px';
  createRoot(document.getElementById('app')).render(<CypressTarget />);
} else {
  createRoot(document.getElementById('app')).render(<RuntimeTargets />);
  if (new URLSearchParams(location.search).has('roots')) {
    const host = document.createElement('div'); host.id = 'shadow-review-root';
    host.style.cssText = 'position:absolute;left:460px;top:130px;width:300px;height:100px';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>button{width:260px;height:48px;font:16px sans-serif}</style><div></div>';
    document.body.append(host);
    createRoot(shadow.querySelector('div')).render(<CypressTarget />);
    const frame = document.createElement('iframe'); frame.id = 'embedded-review-frame';
    frame.style.cssText = 'position:absolute;left:460px;top:310px;width:400px;height:300px;border:0';
    frame.src = '/?embedded'; document.body.append(frame);
  }
}
