'use strict';
// Translate only explicitly marked UI. Task titles, notes and custom labels stay untouched.
const i18n = {
  language: 'zh-CN',
  error(text) {
    if (this.language !== 'en') return text;
    if (WithYouMessages.english[text]) return tr(text);
    for (const [key] of Object.entries(WithYouMessages.english)) {
      if (!key.includes('{')) continue;
      const expression = key.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? '(.*?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      const match = String(text).match(new RegExp('^' + expression + '$'));
      if (match) return WithYouMessages.translate('en', key, ...match.slice(1));
    }
    return text;
  },
  apply() {
    document.documentElement.lang = this.language;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = tr(element.dataset.i18n);
    }
    for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
      for (const element of document.querySelectorAll('[data-i18n-' + attribute + ']')) {
        element.setAttribute(attribute, tr(element.getAttribute('data-i18n-' + attribute)));
      }
    }
    for (const element of document.querySelectorAll('[data-brand]')) element.textContent = tr('携手');
  },
  setLanguage(language) {
    const next = language === 'en' ? 'en' : 'zh-CN';
    if (next === this.language) return;
    this.language = next;
    this.apply();
    window.dispatchEvent(new Event('withyou:language'));
  },
};
const tr = (message, ...values) => WithYouMessages.translate(i18n.language, message, ...values);
(async () => {
  const entry = document.currentScript.dataset.entry;
  const settings = await window.withyou.settings.get();
  i18n.language = settings.language === 'en' ? 'en' : 'zh-CN';
  i18n.apply();
  window.withyou.app.onLanguageChanged?.(language => i18n.setLanguage(language));
  const script = src => new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.onload = resolve;
    element.onerror = reject;
    document.body.appendChild(element);
  });
  await script('error-hook.js');
  await script('dialogs.js');
  if (entry) await script(entry);
  if (entry === 'app.js') { await script('settings.js'); await script('ai.js'); }
})().catch(error => { console.error('Could not initialize language', error); });
