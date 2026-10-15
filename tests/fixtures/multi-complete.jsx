import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function SelectionTargets() {
  const [count, setCount] = useState(0), [offset, setOffset] = useState(0);
  const record = () => setCount((value) => value + 1);
  const targets = [
    <button key="01" id="multi-01" data-testid="review-01" onClick={record}>Review 01</button>,
    <button key="02" id="multi-02" data-testid="review-02" onClick={record}>Review 02</button>,
    <button key="03" id="multi-03" data-testid="review-03" onClick={record}>Review 03</button>,
    <button key="04" id="multi-04" data-testid="review-04" onClick={record}>Review 04</button>,
    <button key="05" id="multi-05" data-testid="review-05" onClick={record}>Review 05</button>,
    <button key="06" id="multi-06" data-testid="review-06" onClick={record}>Review 06</button>,
    <button key="07" id="multi-07" data-testid="review-07" onClick={record}>Review 07</button>,
    <button key="08" id="multi-08" data-testid="review-08" onClick={record}>Review 08</button>,
    <button key="09" id="multi-09" data-testid="review-09" onClick={record}>Review 09</button>,
    <button key="10" id="multi-10" data-testid="review-10" onClick={record}>Review 10</button>,
    <button key="11" id="multi-11" data-testid="review-11" onClick={record}>Review 11</button>,
    <button key="12" id="multi-12" data-testid="review-12" onClick={record}>Review 12</button>,
    <button key="13" id="multi-13" data-testid="review-13" onClick={record}>Review 13</button>,
    <button key="14" id="multi-14" data-testid="review-14" onClick={record}>Review 14</button>,
    <button key="15" id="multi-15" data-testid="review-15" onClick={record}>Review 15</button>,
    <button key="16" id="multi-16" data-testid="review-16" onClick={record}>Review 16</button>,
    <button key="17" id="multi-17" data-testid="review-17" onClick={record}>Review 17</button>,
    <button key="18" id="multi-18" data-testid="review-18" onClick={record}>Review 18</button>,
    <button key="19" id="multi-19" data-testid="review-19" onClick={record}>Review 19</button>,
    <button key="20" id="multi-20" data-testid="review-20" onClick={record}>Review 20</button>,
  ];
  // Retain actual JSX allocation frames in both browser engines.
  if (targets.some((target) => target.type !== 'button')) throw new Error('Expected native targets');
  return <main>
    <div id="host-controls"><button id="native-counter" onClick={record}>Count native clicks</button><output aria-label="Native click count">{count}</output><button id="reflow" onClick={() => setOffset((value) => value + 36)}>Move original targets</button></div>
    <div id="target-grid" style={{ transform: `translateY(${offset}px)` }}>{targets}</div>
  </main>;
}

createRoot(document.getElementById('app')).render(<SelectionTargets />);
