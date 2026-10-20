/* The submitted lab remains self-contained. The hosted copy loads its quote here. */
import { validateQuote } from '/quote-contract.mjs';

(() => {
  const text = document.querySelector('.quote blockquote p');
  const caption = document.querySelector('.quote figcaption');
  if (!text || !caption) return;
  document.title = 'Цитаты · ЛР7';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Получить цитату';
  const status = document.createElement('small');
  status.setAttribute('role', 'status');
  const controls = document.createElement('div');
  controls.append(button, document.createTextNode(' '), status);
  caption.after(controls);
  async function update() {
    button.disabled = true;
    status.textContent = 'Загрузка…';
    try {
      const response = await fetch('/api/v1/quote', {credentials: 'same-origin',
        cache: 'no-store', headers: {Accept: 'application/json'},
        signal: AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('Request failed');
      const quote = await response.json();
      if (!validateQuote(quote)) throw new Error('Invalid quote');
      text.textContent = `«${quote.text}»`;
      const details = [quote.attribution.speaker, quote.attribution.work];
      if (Number.isInteger(quote.attribution.season)) details.push(`${quote.attribution.season}-й сезон`);
      if (Number.isInteger(quote.attribution.episode)) details.push(`${quote.attribution.episode}-я серия`);
      const source = document.createElement('a');
      source.href = quote.attribution.sourceUrl;
      source.rel = 'noreferrer';
      source.textContent = 'Источник';
      caption.replaceChildren(document.createTextNode(details.join(', ') + '. '), source);
      status.textContent = 'Цитата получена с сервера';
    } catch {
      status.textContent = 'Сервер недоступен. Показана сохранённая цитата.';
    } finally {
      button.disabled = false;
    }
  }
  button.addEventListener('click', update);
  update();
})();
