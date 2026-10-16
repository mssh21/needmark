<script setup lang="ts">
import { ref } from 'vue';

const clicks = ref(0);
const status = ref('');
const articles = Array.from({ length: 10 }, (_, index) => index + 1);

function submit(event: Event) {
  status.value = `Thanks, ${new FormData(event.currentTarget as HTMLFormElement).get('name')}.`;
}
</script>

<template>
  <header>
    <strong>NeedMark example: Vite + Vue</strong>
    <nav><a href="#buttons">Buttons</a> <a href="#form">Form</a> <a href="#media">Media</a> <a href="#frames">Iframes</a> <a href="#long">Long page</a></nav>
  </header>
  <main>
    <h1>Review target</h1>
    <p>A Vue app served by Vite with the NeedMark plugin.</p>
    <section id="buttons">
      <h2>Buttons</h2>
      <div class="buttons">
        <button type="button" class="primary" @click="clicks++">Clicked {{ clicks }} times</button>
        <button type="button">Secondary</button>
        <button type="button" disabled>Disabled</button>
      </div>
    </section>
    <section id="form">
      <h2>Form</h2>
      <form @submit.prevent="submit">
        <label>Name <input name="name" autocomplete="name" required></label>
        <label>Email <input name="email" type="email" autocomplete="email"></label>
        <label>Topic
          <select name="topic"><option>Question</option><option>Bug report</option><option>Other</option></select>
        </label>
        <label>Message <textarea name="message" rows="3"></textarea></label>
        <label><input name="subscribe" type="checkbox"> Subscribe to updates</label>
        <button type="submit" class="primary">Send</button>
        <p role="status">{{ status }}</p>
      </form>
    </section>
    <section id="media">
      <h2>Image</h2>
      <img src="/photo.svg" alt="Mountains under a clear sky" width="640" height="360">
    </section>
    <section id="frames">
      <h2>Iframes</h2>
      <h3>Same origin</h3>
      <iframe src="/embed.html" title="Same-origin widget"></iframe>
      <h3>Cross origin (Google Maps)</h3>
      <iframe src="https://maps.google.com/maps?q=Tokyo%20Station&z=15&output=embed" title="Map of Tokyo Station" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
    </section>
    <div id="long">
      <section v-for="article in articles" :key="article">
        <h2>Article {{ article }}</h2>
        <p>This section makes the page long enough to scroll. Leave comments on content far below the first screen and check that pins stay attached while scrolling.</p>
        <p>Paragraph two of article {{ article }} adds more text so each section has a realistic height.</p>
      </section>
    </div>
  </main>
</template>
