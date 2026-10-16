import { ContactForm, Counter } from './interactive';

const articles = Array.from({ length: 10 }, (_, index) => index + 1);

export default function Page() {
  return (
    <>
      <header>
        <strong>NeedMark example: Next.js</strong>
        <nav><a href="#buttons">Buttons</a> <a href="#form">Form</a> <a href="#media">Media</a> <a href="#frames">Iframes</a> <a href="#long">Long page</a></nav>
      </header>
      <main>
        <h1>Review target</h1>
        <p>A Next.js App Router app reviewed through <code>needmark dev</code>.</p>
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
