// Applies the saved theme before the page paints, so a dark theme does not flash light.
(() => {
  let theme = 'system';
  try { theme = JSON.parse(localStorage.getItem('orbit.preferences.v1'))?.theme || 'system'; } catch {}
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
