'use client';

import { useState, type FormEvent } from 'react';

export function Counter() {
  const [clicks, setClicks] = useState(0);
  return <button type="button" className="primary" onClick={() => setClicks(clicks + 1)}>Clicked {clicks} times</button>;
}

export function ContactForm() {
  const [status, setStatus] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(`Thanks, ${new FormData(event.currentTarget).get('name')}.`);
  }
  return (
    <form onSubmit={submit}>
      <label>Name <input name="name" autoComplete="name" required /></label>
      <label>Email <input name="email" type="email" autoComplete="email" /></label>
      <label>Topic
        <select name="topic"><option>Question</option><option>Bug report</option><option>Other</option></select>
      </label>
      <label>Message <textarea name="message" rows={3} /></label>
      <label><input name="subscribe" type="checkbox" /> Subscribe to updates</label>
      <button type="submit" className="primary">Send</button>
      <p role="status">{status}</p>
    </form>
  );
}
