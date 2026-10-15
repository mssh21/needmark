import { createRoot } from 'react-dom/client';

function RouteTarget() {
  const button = <button data-cy="route-checkout">Checkout on child route</button>;
  // Retain the actual JSX creation frame in both browser engines.
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

const kind = new URLSearchParams(location.search).get('frame');
if (kind === 'leaf') {
  createRoot(document.getElementById('app')).render(<RouteTarget />);
} else if (kind === 'outer') {
  const host = document.createElement('section');
  host.id = 'nested-shadow-root';
  host.style.cssText = 'position:absolute;left:30px;top:80px;width:500px;height:360px';
  const shadow = host.attachShadow({ mode: 'open' });
  const frame = document.createElement('iframe');
  frame.id = 'inner-review-frame';
  frame.style.cssText = 'width:480px;height:330px;border:0';
  frame.src = '/?frame=leaf&screen=details#inner-A';
  shadow.append(frame);
  document.body.append(host);
} else {
  createRoot(document.getElementById('app')).render(<h1>Child route review</h1>);
  const frame = document.createElement('iframe');
  frame.id = 'outer-review-frame';
  frame.style.cssText = 'position:absolute;left:260px;top:120px;width:660px;height:600px;border:0';
  frame.src = new URLSearchParams(location.search).has('nested')
    ? '/?frame=outer&screen=orders#outer-A' : '/?frame=leaf&screen=checkout#route-A';
  document.body.append(frame);
}
