// Service worker: оболочка плеера (HTML/CSS/JS/иконки) работает офлайн.
// Музыка лежит в IndexedDB браузера и от сети не зависит.
// Чтобы принудительно обновить кэш после правок, увеличьте номер версии.
const CACHE = 'chestikovv-player-v1';
const SHELL = [
    './',
    'index.html',
    'styles/main.css',
    'scripts/main.js',
    'manifest.json',
    'assets/icons/meicon.png',
    'assets/icons/me-question.png'
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // Отсутствующий файл не должен ломать установку целиком
        await Promise.allSettled(SHELL.map(url => cache.add(url)));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

// Сеть в приоритете (код всегда свежий), при отсутствии сети или таймауте берём кэш
async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    try {
        const response = await fetch(request, { signal: controller.signal });
        if (response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
    } catch (err) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === 'navigate') {
            const page = (await cache.match('index.html')) || (await cache.match('./'));
            if (page) return page;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(networkFirst(request));
});