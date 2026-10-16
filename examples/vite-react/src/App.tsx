import { useState, type FormEvent } from 'react';

const articles = Array.from({ length: 10 }, (_, index) => index + 1);

function Counter() {
  const [clicks, setClicks] = useState(0);
  return <button type="button" className="primary" onClick={() => setClicks(clicks + 1)}>Clicked {clicks} times</button>;
}

function ContactForm() {
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

export function App() {
  return (
    <>
      <header>
        <strong>NeedMark example: Vite + React</strong>
        <nav><a href="#buttons">Buttons</a> <a href="#form">Form</a> <a href="#media">Media</a> <a href="#frames">Iframes</a> <a href="#long">Long page</a></nav>
      </header>
      <main>
        <h1>Review target</h1>
        <p>A React app served by Vite with the NeedMark plugin.</p>
        <section id="buttons">
          <h2>Buttons</h2>
          <div className="buttons">
            <Counter />
            <button type="button">Secondary</button>
            <button type="button" disabled>Disabled</button>
          </div>
        </section>
        <section id="form">
          <h2>Form</h2>
          <ContactForm />
        </section>
        <section id="media">
          <h2>Image</h2>
          <img src="/photo.svg" alt="Mountains under a clear sky" width={640} height={360} />
        </section>
        <section id="frames">
          <h2>Iframes</h2>
          <h3>Same origin</h3>
          <iframe src="/embed.html" title="Same-origin widget" />
          <h3>Cross origin (Google Maps)</h3>
          <iframe src="https://maps.google.com/maps?q=Tokyo%20Station&z=15&output=embed" title="Map of Tokyo Station" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        </section>
        <div id="long">
          {articles.map((article) => (
            <section key={article}>
              <h2>Article {article}</h2>
              <p>This section makes the page long enough to scroll. Leave comments on content far below the first screen and check that pins stay attached while scrolling.</p>
              <p>Paragraph two of article {article} adds more text so each section has a realistic height.</p>
            </section>
          ))}
        </div>
      </main>
    </>
  );
}
