import { createRoot } from 'react-dom/client';

function RetainedFrameButton() {
  const button = <button id="retained-frame-button" className="primary purchase" data-testid="retained-purchase">Retained creation frame</button>;
  // Keep the JSX creation call outside a tail position so JavaScriptCore retains this frame.
  if (button.type !== 'button') throw new Error('Expected a native button');
  return button;
}

export function mountRetainedFrameButton(container: HTMLElement) {
  createRoot(container).render(<RetainedFrameButton />);
}
