import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function CaptureTarget() {
  const [count, setCount] = useState(0);
  const button = <button data-cy="frame-live-button" style={{ backgroundColor: count ? '#d95b24' : '#146ec9' }} onClick={() => setCount(count + 1)}>Current child {count}</button>;
  // Keep the actual native JSX creation frame available in both engines.
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

const kind = new URLSearchParams(location.search).get('frame');
if (kind === 'leaf') {
  createRoot(document.getElementById('app')).render(<CaptureTarget />);
  const note = document.createElement('div');
  note.id = 'live-note'; note.contentEditable = 'true'; note.setAttribute('role', 'textbox'); note.setAttribute('aria-label', 'Live child note'); note.textContent = 'i';
  document.body.append(note);
  const password = document.createElement('input');
  password.id = 'child-password'; password.type = 'password'; password.value = 'child-private';
  document.body.append(password);
  const redact = document.createElement('div');
  redact.id = 'child-redact'; redact.dataset.needmarkRedact = ''; redact.textContent = 'Private child';
  document.body.append(redact);
  const marker = document.createElement('div'); marker.id = 'child-marker'; document.body.append(marker);
} else if (kind === 'outer') {
  const frame = document.createElement('iframe'); frame.id = 'inner-capture-frame';
  frame.style.cssText = 'position:absolute;left:30px;top:420px;width:560px;height:420px;border:0';
  frame.src = '/?frame=leaf&screen=capture#current'; document.body.append(frame);
} else {
  createRoot(document.getElementById('app')).render(<h1>Current child capture</h1>);
  const frame = document.createElement('iframe'); frame.id = 'outer-capture-frame';
  frame.style.cssText = 'position:absolute;left:200px;top:120px;width:660px;height:520px;border:0';
  frame.src = new URLSearchParams(location.search).has('nested') ? '/?frame=outer' : '/?frame=leaf&screen=capture#current';
  if (new URLSearchParams(location.search).has('inline')) {
    const line = document.createElement('section'); line.id = 'inline-frame-line';
    line.style.cssText = 'position:absolute;left:70px;top:170px;width:1050px;background:white;font:20px/32px monospace;white-space:nowrap';
    const style = document.createElement('style'); style.textContent = '#inline-frame-line{color:#000}';
    frame.style.cssText = 'display:inline-block;vertical-align:top;width:660px;height:440px;border:0';
    line.append(document.createTextNode('BEFORE '), style, frame, document.createTextNode(' AFTER'));
    document.body.append(line);
  } else document.body.append(frame);
  const password = document.createElement('input'); password.id = 'root-password'; password.type = 'password'; password.value = 'root-private'; document.body.append(password);
  const redact = document.createElement('div'); redact.id = 'root-redact'; redact.dataset.needmarkRedact = ''; redact.textContent = 'Private root'; document.body.append(redact);
  const marker = document.createElement('div'); marker.id = 'root-marker'; document.body.append(marker);
}
