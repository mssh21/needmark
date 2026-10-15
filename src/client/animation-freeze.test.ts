import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTimerFreeze, type TimerSurface } from './animation-freeze.js';

function clockSurface() {
  let id = 0;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  const timeout = ((callback: Function, delay = 0, ...args: unknown[]) => {
    const key = ++id;
    handles.set(key, setTimeout(() => { handles.delete(key); Reflect.apply(callback, surface, args); }, delay));
    return key;
  }) as Window['setTimeout'];
  const cancel = (key?: number) => { clearTimeout(handles.get(key!)); handles.delete(key!); };
  const surface: TimerSurface = {
    setTimeout: timeout, clearTimeout: cancel, clearInterval: cancel,
    setInterval: ((callback: Function, delay = 0, ...args: unknown[]) => {
      const key = ++id; handles.set(key, setInterval(() => Reflect.apply(callback, surface, args), delay)); return key;
    }) as Window['setInterval'],
    requestAnimationFrame: (callback) => timeout(() => callback(Date.now()), 16), cancelAnimationFrame: cancel,
  };
  return surface;
}
afterEach(() => { vi.useRealTimers(); });

describe('page timer freeze', () => {
  it('keeps matured timeout IDs cancelable by either timer cancellation API, including after resume', () => {
    vi.useFakeTimers(); const surface = clockSurface(), freeze = installTimerFreeze(surface);
    const canceled = vi.fn(), canceledAfterResume = vi.fn(), kept = vi.fn();
    freeze.pause();
    const first = surface.setTimeout(canceled, 10), second = surface.setTimeout(canceledAfterResume, 20);
    surface.setTimeout(kept, 30);
    vi.advanceTimersByTime(50);
    surface.clearInterval(first); freeze.resume(); surface.clearTimeout(second);
    vi.advanceTimersByTime(16);
    expect(canceled).not.toHaveBeenCalled(); expect(canceledAfterResume).not.toHaveBeenCalled(); expect(kept).toHaveBeenCalledOnce();
    freeze.pause(); freeze.resume(); vi.advanceTimersByTime(100); expect(kept).toHaveBeenCalledOnce();
  });

  it('paces overdue one-shots, preserves arguments and this, and drops missed interval ticks', () => {
    vi.useFakeTimers(); const surface = clockSurface(), freeze = installTimerFreeze(surface), calls: unknown[] = [];
    const interval = vi.fn(); surface.setInterval(interval, 10);
    freeze.pause();
    for (const value of ['first', 'second', 'third']) surface.setTimeout(function(this: unknown, arg: unknown) { calls.push([this, arg]); }, 5, value);
    vi.advanceTimersByTime(1000); expect(interval).not.toHaveBeenCalled(); expect(calls).toEqual([]);
    freeze.resume(); vi.advanceTimersByTime(10); expect(interval).toHaveBeenCalledOnce(); expect(calls).toEqual([]);
    vi.advanceTimersByTime(6); expect(calls).toEqual([[surface, 'first']]);
    vi.advanceTimersByTime(16); expect(calls).toEqual([[surface, 'first'], [surface, 'second']]);
    vi.advanceTimersByTime(16); expect(calls).toEqual([[surface, 'first'], [surface, 'second'], [surface, 'third']]);
    expect(interval).toHaveBeenCalledTimes(4);
  });

  it('resumes rAF with a fresh timestamp and supports cancellation with the original ID after rescheduling', () => {
    vi.useFakeTimers(); const surface = clockSurface(), freeze = installTimerFreeze(surface);
    const kept = vi.fn(), canceled = vi.fn();
    freeze.pause(); const original = surface.requestAnimationFrame(canceled); surface.requestAnimationFrame(kept);
    vi.advanceTimersByTime(1000); expect(kept).not.toHaveBeenCalled();
    freeze.resume(); surface.cancelAnimationFrame(original); const now = Date.now(); vi.advanceTimersByTime(16);
    expect(canceled).not.toHaveBeenCalled(); expect(kept).toHaveBeenCalledExactlyOnceWith(now + 16);
  });

  it('preserves the pending queue through another pause and does not resurrect canceled work', () => {
    vi.useFakeTimers(); const surface = clockSurface(), freeze = installTimerFreeze(surface), calls: number[] = [];
    freeze.pause(); surface.setTimeout(() => calls.push(1), 0); const second = surface.setTimeout(() => calls.push(2), 0);
    surface.setTimeout(() => calls.push(3), 0); vi.advanceTimersByTime(5);
    freeze.resume(); vi.advanceTimersByTime(16); freeze.pause(); surface.clearTimeout(second); vi.advanceTimersByTime(100);
    expect(calls).toEqual([1]); freeze.resume(); vi.advanceTimersByTime(16); expect(calls).toEqual([1, 3]);
  });

  it('keeps later queued callbacks runnable when an application callback throws', () => {
    vi.useFakeTimers(); const surface = clockSurface(), freeze = installTimerFreeze(surface), kept = vi.fn();
    freeze.pause(); surface.setTimeout(() => { throw new Error('Application error'); }, 0); surface.setTimeout(kept, 0);
    vi.advanceTimersByTime(1); freeze.resume(); expect(() => vi.advanceTimersByTime(16)).toThrow('Application error');
    vi.advanceTimersByTime(16); expect(kept).toHaveBeenCalledOnce();
  });

  it('preserves ordinary timer cancellation, shared timer IDs and rAF behavior when unpaused', () => {
    vi.useFakeTimers(); const surface = clockSurface(); installTimerFreeze(surface);
    const timer = vi.fn(), interval = vi.fn(), frame = vi.fn();
    const id = surface.setTimeout(timer, 10); surface.clearInterval(String(id) as unknown as number);
    const intervalId = surface.setInterval(interval, 10); surface.requestAnimationFrame(frame);
    vi.advanceTimersByTime(16); expect(timer).not.toHaveBeenCalled(); expect(interval).toHaveBeenCalledOnce(); expect(frame).toHaveBeenCalledOnce();
    surface.clearTimeout(intervalId); vi.advanceTimersByTime(100); expect(interval).toHaveBeenCalledOnce();
  });
});
