// Registers the PWA service worker (public/sw.js) once the page has fully
// loaded, so it never competes with the initial render/critical-path
// fetches for bandwidth. Progressive enhancement only - installability/
// offline support degrades silently, never blocks or breaks the app, on a
// browser without support or a failed registration (e.g. plain http in
// some local dev setups; service workers require a secure context).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
