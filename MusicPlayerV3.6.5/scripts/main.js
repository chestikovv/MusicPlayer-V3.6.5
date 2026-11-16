const DEFAULT_PLAYLIST = "Все треки";
let playlists = { [DEFAULT_PLAYLIST]: makePlaylist(DEFAULT_PLAYLIST) };
let activePlaylist = DEFAULT_PLAYLIST;
let activeAlbum = null;
let currentTrackIndex = -1; // устарело: позиция теперь хранится в queue
const library = new Map();               // id -> трек (каждый трек хранится один раз)
let queue = { ids: [], pos: -1 };        // очередь воспроизведения не зависит от открытого списка
let shuffleHistory = [];
let repeatMode = localStorage.getItem('repeatMode') || 'off'; // off | all | one

// Плейлист хранит только id треков; tracks — готовое представление для остального кода
function makePlaylist(name, ids = [], cover = null, coverBlob = null) {
    return { name, trackIds: ids, cover, coverBlob, get tracks() { return this.trackIds.map(id => library.get(id)).filter(Boolean); } };
}
const fileKey = (f) => `${f.name}|${f.size}`;
const idbReq = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const normalizeText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// Старая схема хранила копию трека на каждый плейлист. Копии склеиваются с оригиналом по имени и размеру файла.
async function migrateToV2(songs) {
    const base = new Map();
    songs.filter(s => !s.playlist || s.playlist === DEFAULT_PLAYLIST).forEach(s => base.set(fileKey(s.file), s.id));
    const ids = {};
    const tx = db.transaction(['songs', 'settings'], 'readwrite');
    const store = tx.objectStore('songs');
    songs.forEach(s => {
        if (!s.playlist || s.playlist === DEFAULT_PLAYLIST) return;
        let id = base.get(fileKey(s.file));
        if (id === undefined) { // оригинал удалён: копия становится обычным треком
            const rec = { ...s }; delete rec.playlist; store.put(rec);
            base.set(fileKey(s.file), s.id); id = s.id;
        } else store.delete(s.id);
        (ids[s.playlist] = ids[s.playlist] || []).push(id);
    });
    Object.keys(ids).forEach(k => { ids[k] = [...new Set(ids[k])]; });
    tx.objectStore('settings').put(ids, 'playlist_ids');
    tx.objectStore('settings').put(2, 'schema');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
    return idbReq(db.transaction(['songs'], 'readonly').objectStore('songs').getAll());
}
let isRepeat = false, isShuffle = false;
let searchQuery = "", editTarget = null, draggedIndex = null;
let bgUrl = null;
let albums = {};
let playerOrientation = 'vertical';
let displayMode = localStorage.getItem('displayMode') || 'artist';
let sleepTimerInterval = null;
let sleepTimerEndTime = null;
let abLoop = { active: false, a: null, b: null };
let isSidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
let isTracksPanelCollapsed = localStorage.getItem('tracksPanelCollapsed') === 'true';

// Мобильный режим: панели работают как выезжающие drawer'ы (состояние не сохраняется)
const MOBILE_QUERY = window.matchMedia('(max-width: 900px)');
let isSidebarOpen = false;
let isTracksOpen = false;
function isMobileView() { return MOBILE_QUERY.matches; }
function isSidebarMini() { return isSidebarCollapsed && !isMobileView(); }
function isTracksMini() { return isTracksPanelCollapsed && !isMobileView(); }

const audio = document.getElementById('audio-core');
const progress = document.getElementById('progress-slider');
const volumeSlider = document.getElementById('volume-slider');
const dz = document.getElementById('drop-zone');
const dbName = "ChestikovvMusicDB";
let db;
let currentArtistsList = [];

const DEFAULT_COLORS = {
    accent: 'rgb(180, 180, 180)',
    panel: 'rgba(0,0,0,0.6)',
    bg: '#121212'
};

// --- ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ---
const request = indexedDB.open(dbName, 5);

request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('songs')) {
        db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
    }
    if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
    }
    if (!db.objectStoreNames.contains('playlist_covers')) {
        db.createObjectStore('playlist_covers');
    }
};

request.onsuccess = (e) => {
    db = e.target.result;
    loadData().catch(err => console.error('Ошибка загрузки данных', err));
    applyPanelStates();
};

request.onerror = (e) => {
    console.error("Ошибка открытия IndexedDB:", e.target.error);
    alert("Ошибка загрузки данных плеера.");
    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
};

// --- ФУНКЦИИ УПРАВЛЕНИЯ ПАНЕЛЯМИ ---
function toggleSidebar() {
    if (isMobileView()) {
        setDrawer('sidebar', !isSidebarOpen);
        return;
    }
    isSidebarCollapsed = !isSidebarCollapsed;
    localStorage.setItem('sidebarCollapsed', isSidebarCollapsed);
    applyPanelStates();
    renderPlaylistsAndAlbums();
}

function toggleTracksPanel() {
    if (isMobileView()) {
        setDrawer('tracks', !isTracksOpen);
        return;
    }
    isTracksPanelCollapsed = !isTracksPanelCollapsed;
    localStorage.setItem('tracksPanelCollapsed', isTracksPanelCollapsed);
    applyPanelStates();
    renderTracksForActiveView();
}

// Открыть/закрыть мобильную панель ('sidebar' | 'tracks')
function setDrawer(name, open) {
    isSidebarOpen = name === 'sidebar' ? open : false;
    isTracksOpen = name === 'tracks' ? open : false;
    syncDrawerHistory();
    applyPanelStates();

    // При открытии списка треков показываем текущий трек
    if (name === 'tracks' && open) {
        requestAnimationFrame(() => {
            const active = document.querySelector('#songs-container .item.active');
            if (active) active.scrollIntoView({ block: 'center' });
        });
    }
}

function closeDrawers() {
    isSidebarOpen = false;
    isTracksOpen = false;
    syncDrawerHistory();
    applyPanelStates();
}

// Кнопка «Назад» на Android закрывает панель, а не уходит со страницы
let drawerHistoryPushed = false;
function syncDrawerHistory() {
    const anyOpen = isSidebarOpen || isTracksOpen;
    try {
        if (anyOpen && !drawerHistoryPushed) {
            history.pushState({ drawer: true }, '');
            drawerHistoryPushed = true;
        } else if (!anyOpen && drawerHistoryPushed) {
            drawerHistoryPushed = false;
            history.back();
        }
    } catch (e) { drawerHistoryPushed = false; }
}

window.addEventListener('popstate', () => {
    if (drawerHistoryPushed) {
        drawerHistoryPushed = false;
        isSidebarOpen = false;
        isTracksOpen = false;
        applyPanelStates();
    }
});

function applyPanelStates() {
    const sidebar = document.querySelector('.sidebar');
    const tracksPanel = document.querySelector('.tracks-panel');
    const backdrop = document.getElementById('drawer-backdrop');
    const mobile = isMobileView();

    if (sidebar) {
        sidebar.classList.toggle('collapsed', !mobile && isSidebarCollapsed);
        sidebar.classList.toggle('open', mobile && isSidebarOpen);
    }

    if (tracksPanel) {
        tracksPanel.classList.toggle('collapsed', !mobile && isTracksPanelCollapsed);
        tracksPanel.classList.toggle('open', mobile && isTracksOpen);
    }

    const anyOpen = mobile && (isSidebarOpen || isTracksOpen);
    if (backdrop) backdrop.classList.toggle('show', anyOpen);
    document.body.classList.toggle('drawer-open', anyOpen);

    updateMobileNavActive();
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ТРЕКОВ ---
// Реальный объект текущего трека (в альбоме список строится копиями, поэтому ищем оригинал по id)
function getCurrentTrack() { return library.get(queue.ids[queue.pos]) || null; }

// Сохранение трека в IndexedDB
function persistTrack(track) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('База данных недоступна'));
        const req = db.transaction(['songs'], 'readwrite').objectStore('songs').put({
            id: track.id,
            name: track.name,
            artists: track.artists || [],
            album: track.album || '',
            file: track.file,
            coverBlob: track.coverBlob || null
        });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// Если изменённый трек сейчас играет — обновляем плеер
function refreshCurrentTrackView(track) {
    const current = getCurrentTrack();
    if (!current || !track || current.id !== track.id) return;
    document.getElementById('current-track-title').textContent = track.name;
    document.getElementById('main-cover').src = track.cover || 'assets/icons/me-question.png';
    updateArtistsDisplay(track.artists || []);
    updateMediaSession();
}

// Универсальное окно подтверждения
function askConfirm({ title = 'Вы уверены?', text = '', okText = 'Удалить', onConfirm }) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-text').textContent = text;
    const btn = document.getElementById('confirm-modal-btn');
    btn.textContent = okText;
    btn.onclick = () => {
        closeConfirmModal();
        if (onConfirm) onConfirm();
    };
    document.getElementById('confirm-modal').style.display = 'flex';
}

// --- ФУНКЦИИ МЕНЮ ---
function toggleMenu() {
    const menu = document.getElementById('dropdown-menu');
    const menuBtn = document.getElementById('menu-btn');

    if (!menu || !menuBtn) return;

    if (menu.classList.contains('show')) {
        menu.classList.remove('show');
        menuBtn.classList.remove('active');
    } else {
        menu.classList.add('show');
        menuBtn.classList.add('active');
        updateMenuItems();
    }
}

document.addEventListener('click', function(e) {
    const menu = document.getElementById('dropdown-menu');
    const menuBtn = document.getElementById('menu-btn');

    if (menu && menuBtn) {
        if (!menuBtn.contains(e.target) && !menu.contains(e.target)) {
            menu.classList.remove('show');
            menuBtn.classList.remove('active');
        }
    }
});

function updateMenuItems() {
    const abLoopItem = document.getElementById('ab-loop-menu-item');
    const sleepTimerItem = document.getElementById('sleep-timer-menu-item');

    if (abLoopItem) {
        if (abLoop.active || abLoop.a !== null) {
            abLoopItem.classList.add('active');
        } else {
            abLoopItem.classList.remove('active');
        }
    }

    if (sleepTimerItem) {
        if (sleepTimerInterval) {
            sleepTimerItem.classList.add('active');
        } else {
            sleepTimerItem.classList.remove('active');
        }
    }
}

// --- ФУНКЦИИ ЭКВАЛАЙЗЕРА ---
function updateEqualizer() {
    const equalizer = document.getElementById('equalizer');
    if (!equalizer) return;

    if (!audio.paused && audio.src && !audio.src.includes('null')) {
        equalizer.style.display = 'flex';
    } else {
        equalizer.style.display = 'none';
    }
}

// --- ФУНКЦИИ ТАЙМЕРА СНА ---
function openSleepTimerModal() {
    document.getElementById('sleep-timer-modal').style.display = 'flex';
    closeMenu();
}

function closeSleepTimerModal() {
    document.getElementById('sleep-timer-modal').style.display = 'none';
}

function closeMenu() {
    const menu = document.getElementById('dropdown-menu');
    const menuBtn = document.getElementById('menu-btn');
    if (menu) menu.classList.remove('show');
    if (menuBtn) menuBtn.classList.remove('active');
}

function setSleepTimer(minutes) {
    if (sleepTimerInterval) {
        clearInterval(sleepTimerInterval);
    }

    const endTime = Date.now() + minutes * 60 * 1000;
    sleepTimerEndTime = endTime;

    sleepTimerInterval = setInterval(() => {
        const remaining = Math.max(0, sleepTimerEndTime - Date.now());

        if (remaining <= 0) {
            audio.pause();
            updatePlayIcon(false);
            cancelSleepTimer();
            showNotification('Таймер сна сработал');
        } else {
            updateSleepTimerIndicator(remaining);
        }
    }, 1000);

    document.getElementById('sleep-timer-indicator').style.display = 'inline-flex';
    closeSleepTimerModal();
    closeMenu();
    updateMenuItems();

    showNotification(`Таймер сна установлен на ${minutes} минут`);
}

function setCustomSleepTimer() {
    const minutes = parseInt(document.getElementById('custom-timer-minutes').value);
    if (minutes && minutes > 0) {
        setSleepTimer(minutes);
    }
}

function cancelSleepTimer() {
    if (sleepTimerInterval) {
        clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;
    }
    sleepTimerEndTime = null;
    document.getElementById('sleep-timer-indicator').style.display = 'none';
    updateMenuItems();
}

function updateSleepTimerIndicator(remainingMs) {
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    document.getElementById('sleep-timer-time').textContent =
        `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// --- ФУНКЦИИ A-B LOOP ---
function toggleABLoop() {
    if (!audio.src || audio.src.includes('null')) {
        showNotification('Сначала выберите трек');
        return;
    }

    if (!abLoop.active) {
        if (abLoop.a === null) {
            abLoop.a = audio.currentTime;
            showNotification(`Точка A: ${formatTime(abLoop.a)}`);
        } else if (abLoop.b === null) {
            if (audio.currentTime > abLoop.a) {
                abLoop.b = audio.currentTime;
                abLoop.active = true;
                showNotification(`A-B loop активирован: ${formatTime(abLoop.a)} - ${formatTime(abLoop.b)}`);
                updateABLoopIndicators();
            } else {
                showNotification('Точка B должна быть позже точки A');
                abLoop.a = null;
            }
        } else {
            resetABLoop();
            abLoop.a = audio.currentTime;
            showNotification(`Новая точка A: ${formatTime(abLoop.a)}`);
        }
    } else {
        abLoop.active = false;
        showNotification('A-B loop отключен');
    }

    updateABLoopUI();
    updateMenuItems();
    closeMenu();
}

function resetABLoop() {
    abLoop = { active: false, a: null, b: null };
    updateABLoopUI();
    updateMenuItems();
}

function updateABLoopUI() {
    const indicator = document.getElementById('ab-loop-indicator');
    const aMarker = document.getElementById('ab-a-marker');
    const bMarker = document.getElementById('ab-b-marker');

    if (abLoop.active) {
        if (indicator) indicator.style.display = 'inline-flex';
        if (aMarker) aMarker.style.display = 'inline';
        if (bMarker) bMarker.style.display = 'inline';
    } else if (abLoop.a !== null) {
        if (indicator) indicator.style.display = 'none';
        if (aMarker) aMarker.style.display = 'inline';
        if (bMarker) bMarker.style.display = 'none';
    } else {
        if (indicator) indicator.style.display = 'none';
        if (aMarker) aMarker.style.display = 'none';
        if (bMarker) bMarker.style.display = 'none';
    }

    updateABLoopIndicators();
}

function updateABLoopIndicators() {
    if (abLoop.a !== null) {
        document.getElementById('ab-a-time').textContent = formatTime(abLoop.a);
    }
    if (abLoop.b !== null) {
        document.getElementById('ab-b-time').textContent = formatTime(abLoop.b);
    }
}

// --- ФУНКЦИИ ПОИСКА С КРЕСТИКОМ ---
function handleSearch(value) {
    searchQuery = value.toLowerCase();
    renderTracksForActiveView();

    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = searchQuery ? 'flex' : 'none';
    }
}

function clearSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
        handleSearch('');
        searchInput.focus();
    }
}

// --- ФУНКЦИИ ДЛЯ РАБОТЫ С НЕСКОЛЬКИМИ ИСПОЛНИТЕЛЯМИ ---
function updateArtistsDisplay(artists) {
    const container = document.getElementById('current-artist');
    if (!container) return;

    if (!artists || artists.length === 0 || (artists.length === 1 && !artists[0])) {
        container.innerHTML = 'Неизвестно';
        container.onclick = () => filterByArtist('Неизвестно');
        return;
    }

    container.innerHTML = '';
    const artistsContainer = document.createElement('div');
    artistsContainer.className = 'artist-names-container';

    artists.forEach((artist, index) => {
        const chip = document.createElement('span');
        chip.className = 'artist-name-chip';
        chip.textContent = artist;
        chip.onclick = (e) => {
            e.stopPropagation();
            filterByArtist(artist);
        };
        artistsContainer.appendChild(chip);

        if (index < artists.length - 1) {
            const separator = document.createElement('span');
            separator.className = 'artist-name-separator';
            separator.textContent = ' feat. ';
            artistsContainer.appendChild(separator);
        }
    });

    container.appendChild(artistsContainer);
}

function filterByArtist(artistName) {
    if (!artistName || artistName === 'Неизвестно') {
        showNotification('Нет информации об исполнителе');
        return;
    }

    activeAlbum = null;
    activePlaylist = DEFAULT_PLAYLIST;
    searchQuery = artistName.toLowerCase();

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = artistName;
        handleSearch(artistName);
    }

    renderTracksForActiveView();
    renderPlaylists();
    renderAlbums();

    showNotification(`Показаны треки исполнителя: ${artistName}`);
}

// --- ФУНКЦИИ ДЛЯ РЕДАКТИРОВАНИЯ ИСПОЛНИТЕЛЕЙ ---
function addArtistField() {
    const container = document.getElementById('artists-container');
    const currentInputs = container.querySelectorAll('.edit-track-artist');
    const newIndex = currentInputs.length;

    const wrapper = document.createElement('div');
    wrapper.className = 'artist-input-wrapper';
    wrapper.innerHTML = `
        <input type="text" id="edit-track-artist-${newIndex}" class="edit-track-artist" placeholder="Имя исполнителя">
        <button class="add-artist-btn" onclick="addArtistField()">
            <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/>
            </svg>
        </button>
    `;

    container.appendChild(wrapper);

    // Убираем кнопку плюс у предыдущего инпута
    if (currentInputs.length > 0) {
        const prevWrapper = currentInputs[currentInputs.length - 1].parentElement;
        const prevBtn = prevWrapper.querySelector('.add-artist-btn');
        if (prevBtn) {
            const newBtn = prevBtn.cloneNode(true);
            prevBtn.parentNode.replaceChild(newBtn, prevBtn);
        }
    }
}

function getArtistsFromInputs() {
    const inputs = document.querySelectorAll('.edit-track-artist');
    const artists = [];
    inputs.forEach(input => {
        const val = input.value.trim();
        if (val) artists.push(val);
    });
    return artists;
}

function setArtistsInputs(artists) {
    const container = document.getElementById('artists-container');
    container.innerHTML = '';

    if (!artists || artists.length === 0) {
        const wrapper = document.createElement('div');
        wrapper.className = 'artist-input-wrapper';
        wrapper.innerHTML = `
            <input type="text" id="edit-track-artist-0" class="edit-track-artist" placeholder="Имя исполнителя">
            <button class="add-artist-btn" onclick="addArtistField()">
                <svg viewBox="0 0 24 24" width="18" height="18">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/>
                </svg>
            </button>
        `;
        container.appendChild(wrapper);
        return;
    }

    artists.forEach((artist, idx) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'artist-input-wrapper';
        wrapper.innerHTML = `
            <input type="text" id="edit-track-artist-${idx}" class="edit-track-artist" placeholder="Имя исполнителя" value="${escapeHtml(artist)}">
            <button class="add-artist-btn" onclick="addArtistField()">
                <svg viewBox="0 0 24 24" width="18" height="18">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/>
                </svg>
            </button>
        `;
        container.appendChild(wrapper);
    });
}

// --- ФУНКЦИЯ УСТАНОВКИ ОРИЕНТАЦИИ ПЛЕЕРА ---
function setPlayerOrientation(orientation) {
    playerOrientation = orientation;
    localStorage.setItem('playerOrientation', orientation);

    const playerCenter = document.querySelector('.player-center');
    const verticalBtn = document.getElementById('orientation-vertical');
    const horizontalBtn = document.getElementById('orientation-horizontal');

    if (orientation === 'horizontal') {
        playerCenter.classList.add('horizontal-layout');
        if (verticalBtn) verticalBtn.classList.remove('active');
        if (horizontalBtn) horizontalBtn.classList.add('active');
    } else {
        playerCenter.classList.remove('horizontal-layout');
        if (verticalBtn) verticalBtn.classList.add('active');
        if (horizontalBtn) horizontalBtn.classList.remove('active');
    }
}

// --- ФУНКЦИИ ИЗМЕНЕНИЯ ЦВЕТОВ ---
function changeAccentColor(c) {
    document.documentElement.style.setProperty('--accent', c);
    localStorage.setItem('grig_accent_color', c);
    const picker = document.getElementById('accent-color-input');
    if (picker) picker.value = rgbToHex(c);
}

function changeMainBgColor(c) {
    document.documentElement.style.setProperty('--main-bg', c);
    localStorage.setItem('grig_main_bg_color', c);

    const bgLayer = document.getElementById('custom-bg');
    if (!bgLayer.style.backgroundImage || bgLayer.style.backgroundImage === 'none') {
        bgLayer.style.backgroundColor = c;
    }

    const picker = document.getElementById('bg-color-input');
    if (picker) picker.value = rgbToHex(c);
}

function changePanelBgColor(c) {
    document.documentElement.style.setProperty('--panel-bg', c);
    localStorage.setItem('grig_panel_bg_color', c);

    const picker = document.getElementById('panel-color-input');
    if (picker) picker.value = rgbToHex(c);
}

function resetAccentColor() {
    changeAccentColor(DEFAULT_COLORS.accent);
    const picker = document.getElementById('accent-color-input');
    if (picker) picker.value = rgbToHex(DEFAULT_COLORS.accent);
    showNotification('Цвет акцента сброшен');
}

function resetPanelColor() {
    changePanelBgColor(DEFAULT_COLORS.panel);
    const picker = document.getElementById('panel-color-input');
    if (picker) picker.value = rgbToHex(DEFAULT_COLORS.panel);
    showNotification('Цвет панелей сброшен');
}

function resetBgColor() {
    changeMainBgColor(DEFAULT_COLORS.bg);
    const picker = document.getElementById('bg-color-input');
    if (picker) picker.value = DEFAULT_COLORS.bg;

    const bgLayer = document.getElementById('custom-bg');
    if (!bgLayer.style.backgroundImage || bgLayer.style.backgroundImage === 'none') {
        bgLayer.style.backgroundColor = DEFAULT_COLORS.bg;
    }

    showNotification('Цвет фона сброшен');
}

// --- ФУНКЦИИ РЕЖИМА ОТОБРАЖЕНИЯ ---
function changeDisplayMode(mode) {
    displayMode = mode;
    localStorage.setItem('displayMode', mode);
    updateTrackInfoDisplay();
    showNotification(`Режим отображения изменён`);
}

function updateTrackInfoDisplay() {
    const artistElement = document.getElementById('current-artist');
    const playlistNameElement = document.getElementById('current-playlist-name');
    const trackInfoContainer = document.querySelector('.track-info');

    if (!artistElement || !playlistNameElement || !trackInfoContainer) return;

    const oldSecondary = document.getElementById('track-info-secondary');
    if (oldSecondary) oldSecondary.remove();

    let playlistText = playlistNameElement.textContent.replace('Плейлист: ', '').replace('Альбом: ', '');
    let isAlbum = playlistNameElement.textContent.startsWith('Альбом:');

    const secondaryInfo = document.createElement('div');
    secondaryInfo.id = 'track-info-secondary';
    secondaryInfo.className = 'track-info-secondary';

    switch(displayMode) {
        case 'artist':
            artistElement.style.display = 'block';
            playlistNameElement.style.display = 'none';
            secondaryInfo.style.display = 'none';
            break;
        case 'playlist':
            artistElement.style.display = 'none';
            playlistNameElement.style.display = 'none';
            secondaryInfo.style.display = 'block';
            secondaryInfo.textContent = isAlbum ? `Альбом: ${playlistText}` : `Плейлист: ${playlistText}`;
            break;
        case 'both':
            artistElement.style.display = 'block';
            playlistNameElement.style.display = 'none';
            secondaryInfo.style.display = 'block';
            secondaryInfo.textContent = isAlbum ? `Альбом: ${playlistText}` : `Плейлист: ${playlistText}`;
            break;
    }

    trackInfoContainer.appendChild(secondaryInfo);
}

// --- ФУНКЦИЯ ДЛЯ УВЕДОМЛЕНИЙ ---
function showNotification(message) {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        bottom: var(--bottom-offset, 20px);
        left: 50%;
        max-width: calc(100vw - 32px);
        text-align: center;
        transform: translateX(-50%);
        background: var(--accent);
        color: white;
        padding: 12px 24px;
        border-radius: 30px;
        font-size: 14px;
        font-weight: 500;
        z-index: 2000;
        animation: slideUp 0.3s ease, fadeOut 0.3s ease 1.7s forwards;
        box-shadow: 0 5px 20px rgba(0,0,0,0.4);
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 2000);
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function formatTime(s) {
    if (isNaN(s) || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60), sc = Math.floor(s % 60);
    return `${m}:${sc < 10 ? '0' : ''}${sc}`;
}

function updatePlayIcon(isPlay) {
    document.getElementById('svg-play').style.display = isPlay ? 'none' : 'block';
    document.getElementById('svg-pause').style.display = isPlay ? 'block' : 'none';
    updateEqualizer();
}

function savePlaylistStructure() {
    const data = {}, ids = {};
    Object.keys(playlists).forEach(k => {
        data[k] = { name: playlists[k].name || k, cover: null, hasCoverBlob: !!playlists[k].coverBlob };
        ids[k] = playlists[k].trackIds;
    });
    localStorage.setItem('playlist_structure', JSON.stringify(data));
    if (db) db.transaction(['settings'], 'readwrite').objectStore('settings').put(ids, 'playlist_ids');
}

function rgbToHex(rgb) {
    if (rgb.startsWith('#')) return rgb;
    const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return '#121212';
    return '#' + ((1 << 24) + (parseInt(match[1]) << 16) + (parseInt(match[2]) << 8) + parseInt(match[3])).toString(16).slice(1);
}

function updateBackgroundUI(blobOrFile) {
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = URL.createObjectURL(blobOrFile);
    document.getElementById('custom-bg').style.backgroundImage = `url(${bgUrl})`;
    document.getElementById('bg-preview-box').style.backgroundImage = `url(${bgUrl})`;
    document.getElementById('bg-plus-icon').style.display = 'none';
}

// --- ФУНКЦИИ АЛЬБОМОВ ---
function updateAlbumsFromTracks() {
    const map = new Map();
    playlists[DEFAULT_PLAYLIST].trackIds.forEach(id => {
        const t = library.get(id);
        const name = t && (t.album || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, { name, trackIds: [], cover: null });
        const a = map.get(key);
        a.trackIds.push(id);
        if (!a.cover && t.cover) a.cover = t.cover; // альбом без обложки больше не пропадает
    });
    const next = {};
    map.forEach((a, key) => {
        if (a.trackIds.length < 2) return;
        const albumId = 'album_' + key.replace(/\s+/g, '_');
        next[albumId] = { id: albumId, ...a };
    });
    albums = next;
    if (activeAlbum && !albums[activeAlbum]) { activeAlbum = null; activePlaylist = DEFAULT_PLAYLIST; }
    renderAlbums();
}

function renderAlbums() {
    const albumsList = document.getElementById('albums-list');
    if (!albumsList) return;

    albumsList.innerHTML = '';

    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl) sidebarEl.classList.toggle('no-albums', !Object.keys(albums).length);

    if (!Object.keys(albums).length && !isSidebarMini()) {
        albumsList.innerHTML = '<div class="empty-state">Альбомы появятся автоматически, когда у двух и более треков совпадёт название альбома</div>';
        return;
    }

    Object.values(albums).forEach(album => {
        const el = document.createElement('div');
        el.className = `album-item ${activeAlbum === album.id ? 'active' : ''}`;
        el.setAttribute('data-title', album.name);
        el.setAttribute('data-count', album.trackIds.length);

        if (isSidebarMini()) {
            el.innerHTML = `<img src="${album.cover || 'assets/icons/me-question.png'}" class="album-cover">`;
        } else {
            el.innerHTML = `
                <img src="${album.cover || 'assets/icons/me-question.png'}" class="album-cover">
                <div class="album-info">
                    <div class="album-name">${escapeHtml(album.name)}</div>
                    <div class="album-track-count">${album.trackIds.length} треков</div>
                </div>
            `;
        }

        el.onclick = (e) => {
            e.stopPropagation();
            if (activeAlbum === album.id) {
                activeAlbum = null;
                activePlaylist = DEFAULT_PLAYLIST;
            } else {
                activeAlbum = album.id;
                activePlaylist = null;
            }
            renderTracksForActiveView();
            renderPlaylists();
            renderAlbums();
            if (isMobileView()) setDrawer('tracks', true);
        };

        const askDeleteAlbum = (e) => {
            e.stopPropagation();
            askConfirm({
                text: `Убрать альбом "${album.name}"? Треки останутся в библиотеке.`,
                onConfirm: () => deleteAlbum(album.id)
            });
        };
        el.ondblclick = askDeleteAlbum;

        // На телефонах двойного клика нет — отдельная кнопка
        if (!isSidebarMini()) {
            const delBtn = document.createElement('button');
            delBtn.className = 'row-action touch-only';
            delBtn.setAttribute('aria-label', 'Удалить альбом');
            delBtn.textContent = '✕';
            delBtn.onclick = askDeleteAlbum;
            el.appendChild(delBtn);
        }

        albumsList.appendChild(el);
    });
}

function deleteAlbum(albumId) { // убирает название альбома у треков, сами треки остаются
    const a = albums[albumId];
    if (!a) return;
    Promise.all(a.trackIds.map(id => { const t = library.get(id); t.album = ''; return persistTrack(t); }))
        .then(() => { updateAlbumsFromTracks(); renderPlaylists(); renderTracksForActiveView(); })
        .catch(() => showNotification('Не удалось сохранить изменения'));
}


// --- ФУНКЦИИ ОТОБРАЖЕНИЯ ---
function renderPlaylists() {
    const pList = document.getElementById('playlist-list');
    if (!pList) return;

    pList.innerHTML = '';
    Object.keys(playlists).forEach(name => {
        const playlist = playlists[name];
        const el = document.createElement('div');
        el.className = `item ${name === activePlaylist && !activeAlbum ? 'active' : ''}`;

        const trackCount = playlist.tracks?.length || 0;
        el.setAttribute('data-title', `${playlist.name || name} (${trackCount} треков)`);
        el.setAttribute('data-count', trackCount);

        if (isSidebarMini()) {
            const coverSrc = playlist.cover || 'assets/icons/me-question.png';
            el.innerHTML = `<img src="${coverSrc}" class="playlist-cover-mini" onerror="this.src='assets/icons/me-question.png'">`;
        } else {
            const coverSrc = playlist.cover || 'assets/icons/me-question.png';
            el.innerHTML = `
                <img src="${coverSrc}" class="playlist-cover-mini" onerror="this.src='assets/icons/me-question.png'">
                <div style="display: flex; flex-direction: column; width: 100%; overflow: hidden;">
                    <div style="font-weight: 500; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(playlist.name || name)}</div>
                    <div style="font-size: 12px; color: #FFFFFF;">треков: ${trackCount}</div>
                </div>
            `;
        }

        el.onclick = () => {
            activePlaylist = name;
            activeAlbum = null;
            localStorage.setItem('activePlaylistName', name);
            renderTracksForActiveView();
            renderPlaylists();
            renderAlbums();
            if (isMobileView()) setDrawer('tracks', true);
        };

        // У «Все треки» нет кнопок: его нельзя ни удалить, ни переименовать
        if (name !== DEFAULT_PLAYLIST && !isSidebarMini()) {
            const editBtn = document.createElement('button');
            editBtn.className = 'row-action';
            editBtn.setAttribute('aria-label', 'Редактировать плейлист');
            editBtn.title = 'Редактировать';
            editBtn.innerHTML = PENCIL_ICON;
            editBtn.onclick = (e) => {
                e.stopPropagation();
                openPlaylistEditModal(name);
            };
            el.appendChild(editBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'row-action row-action-danger';
            deleteBtn.setAttribute('aria-label', 'Удалить плейлист');
            deleteBtn.title = 'Удалить плейлист';
            deleteBtn.innerHTML = TRASH_ICON;
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                openDeleteConfirmModal(name);
            };
            el.appendChild(deleteBtn);
        }

        pList.appendChild(el);
    });
}

function renderPlaylistsAndAlbums() {
    renderAlbums();
    renderPlaylists();
}

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/></svg>';

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function editTrackFromList(track) { openTrackEditModal(track); }

function renderTracksForActiveView() {
    const songList = document.getElementById('songs-container');
    if (!songList) return;
    songList.innerHTML = '';

    const inAlbum = !!(activeAlbum && albums[activeAlbum]);
    document.getElementById('current-playlist-name').textContent = inAlbum
        ? `Альбом: ${albums[activeAlbum].name}`
        : `Плейлист: ${playlists[activePlaylist]?.name || activePlaylist}`;

    const q = normalizeText(searchQuery);
    const visible = [];
    viewIds().forEach((id, index) => {
        const t = library.get(id);
        if (!t) return;
        if (q && !normalizeText([t.name, (t.artists || []).join(' '), t.album].join(' ')).includes(q)) return;
        visible.push({ t, index });
    });
    const visibleIds = visible.map(v => v.t.id); // очередь = то, что видно на экране (с учётом поиска)
    const curId = getCurrentTrack()?.id;
    const removeLabel = inAlbum ? 'Убрать из альбома' : (activePlaylist === DEFAULT_PLAYLIST ? 'Удалить трек' : 'Убрать из плейлиста');

    visible.forEach(({ t, index }) => {
        const el = document.createElement('div');
        el.className = `item ${t.id === curId ? 'active' : ''}`;
        el.dataset.id = t.id;
        const artistDisplay = (t.artists || []).join(' feat. ');
        el.setAttribute('data-title', `${t.name}${artistDisplay ? ` - ${artistDisplay}` : ''}`);
        const cover = `<img src="${t.cover || 'assets/icons/me-question.png'}" class="track-mini-cover">`;

        if (isTracksMini()) {
            el.innerHTML = cover;
        } else {
            el.innerHTML = `${cover}
                <span style="flex:1; overflow:hidden;">
                    <div style="font-weight: 500; margin-bottom: 2px;">${escapeHtml(t.name)}</div>
                    ${artistDisplay ? `<div style="font-size: 12px; opacity: 0.7; color: var(--dim);">${escapeHtml(artistDisplay)}</div>` : ''}
                </span>
                <span class="row-action" data-edit aria-label="Редактировать" title="Редактировать">${PENCIL_ICON}</span>
                <span class="row-action" data-remove aria-label="${removeLabel}" title="${removeLabel}">✕</span>`;
            el.querySelector('[data-edit]').onclick = (e) => { e.stopPropagation(); openTrackEditModal(t); };
            el.querySelector('[data-remove]').onclick = (e) => { e.stopPropagation(); removeTrackFromView(t.id); };
        }

        el.onclick = () => {
            playById(t.id, visibleIds);
            if (isMobileView()) setTimeout(closeDrawers, 150);
        };

        if (!inAlbum && !q) { // порядок меняется только в полном списке и теперь сохраняется
            el.draggable = true;
            el.ondragstart = () => { draggedIndex = index; };
            el.ondragover = (e) => e.preventDefault();
            el.ondrop = () => {
                if (draggedIndex === null || draggedIndex === index) return;
                const arr = playlists[activePlaylist].trackIds;
                arr.splice(index, 0, arr.splice(draggedIndex, 1)[0]);
                draggedIndex = null;
                savePlaylistStructure();
                updateAlbumsFromTracks();
                renderTracksForActiveView();
            };
        }
        songList.appendChild(el);
    });

    if (!visible.length && !isTracksMini()) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        if (searchQuery) empty.textContent = 'Ничего не найдено';
        else if (!inAlbum && activePlaylist === DEFAULT_PLAYLIST) {
            empty.innerHTML = '<p>Здесь пока пусто</p><button class="btn-main" type="button">Добавить музыку</button>';
            empty.querySelector('button').onclick = openAddMusicModal;
        } else empty.textContent = 'В этом плейлисте пока нет треков. Откройте трек в плеере и нажмите «+», чтобы добавить его сюда';
        songList.appendChild(empty);
    }
}

// ✕ в строке: в альбоме — убрать из альбома, в «Все треки» — удалить из библиотеки, в плейлисте — убрать из плейлиста
function removeTrackFromView(id) {
    const t = library.get(id);
    if (!t) return;
    if (activeAlbum && albums[activeAlbum]) {
        t.album = '';
        persistTrack(t).then(() => {
            updateAlbumsFromTracks(); renderPlaylists(); renderTracksForActiveView();
            showNotification('Трек убран из альбома');
        }).catch(() => showNotification('Не удалось сохранить изменения'));
    } else if (activePlaylist === DEFAULT_PLAYLIST) {
        deleteTrackEverywhere(id);
    } else {
        const p = playlists[activePlaylist];
        p.trackIds = p.trackIds.filter(x => x !== id);
        savePlaylistStructure(); renderPlaylists(); renderTracksForActiveView();
        showNotification('Трек убран из плейлиста');
    }
}

function deleteTrackEverywhere(id) {
    const t = library.get(id);
    if (!t || !db) return;
    askConfirm({
        text: `Удалить трек "${t.name}" из библиотеки и всех плейлистов?`,
        onConfirm: () => {
            db.transaction(['songs'], 'readwrite').objectStore('songs').delete(id).onsuccess = () => {
                const curId = getCurrentTrack()?.id;
                library.delete(id);
                Object.values(playlists).forEach(p => { p.trackIds = p.trackIds.filter(x => x !== id); });
                queue.ids = queue.ids.filter(x => x !== id);
                queue.pos = queue.ids.indexOf(curId);
                if (curId === id) {
                    audio.pause(); audio.removeAttribute('src'); audio.load();
                    updatePlayIcon(false);
                    document.getElementById('current-track-title').textContent = 'Выберите трек';
                    updateArtistsDisplay([]);
                }
                URL.revokeObjectURL(t.url);
                if (t.cover) URL.revokeObjectURL(t.cover);
                savePlaylistStructure(); updateAlbumsFromTracks(); renderPlaylistsAndAlbums(); renderTracksForActiveView();
            };
        }
    });
}

// --- ЗАГРУЗКА ДАННЫХ ---
async function loadData() {
    const savedStructure = localStorage.getItem('playlist_structure');
    if (savedStructure) {
        try {
            const parsed = JSON.parse(savedStructure);
            Object.entries(parsed).forEach(([key, data]) => {
                if (key && key !== DEFAULT_PLAYLIST) {
                    playlists[key] = makePlaylist(data.name || key);
                }
            });
        } catch(e) {
            console.error("Ошибка структуры плейлистов", e);
        }
    }

    playlists[DEFAULT_PLAYLIST] = makePlaylist(DEFAULT_PLAYLIST);

    changeAccentColor(localStorage.getItem('grig_accent_color') || DEFAULT_COLORS.accent);
    changeMainBgColor(localStorage.getItem('grig_main_bg_color') || DEFAULT_COLORS.bg);
    changePanelBgColor(localStorage.getItem('grig_panel_bg_color') || DEFAULT_COLORS.panel);

    const savedVol = localStorage.getItem('grig_volume');
    // На телефоне ползунка громкости нет — громкость задаётся кнопками устройства
    if (savedVol !== null && !isMobileView()) {
        audio.volume = parseFloat(savedVol);
        volumeSlider.value = Math.sqrt(audio.volume) * 100;
    }

    setPlayerOrientation(localStorage.getItem('playerOrientation') || 'vertical');

    const savedDisplayMode = localStorage.getItem('displayMode');
    if (savedDisplayMode) {
        displayMode = savedDisplayMode;
    }

    if (db) {
        db.transaction(['settings'], 'readonly').objectStore('settings').get('background').onsuccess = (e) => {
            if (e.target.result) updateBackgroundUI(e.target.result);
        };
    }

    if (!db) return;
    const setting = (k) => idbReq(db.transaction(['settings'], 'readonly').objectStore('settings').get(k));
    let songs = await idbReq(db.transaction(['songs'], 'readonly').objectStore('songs').getAll());
    if (await setting('schema') !== 2) {
        try { songs = await migrateToV2(songs); }
        catch (err) { console.error('Не удалось обновить формат библиотеки', err); }
    }
    library.clear();
    songs.forEach(t => {
        t.url = URL.createObjectURL(t.file);
        if (t.coverBlob) t.cover = URL.createObjectURL(t.coverBlob);
        t.artist = (t.artists || []).join(' feat. ');
        library.set(t.id, t);
    });

    const saved = (await setting('playlist_ids')) || {};
    Object.keys(saved).forEach(n => { if (!playlists[n]) playlists[n] = makePlaylist(n); });
    Object.keys(playlists).forEach(n => {
        if (n !== DEFAULT_PLAYLIST) playlists[n].trackIds = (saved[n] || []).filter(id => library.has(id));
    });
    const order = (saved[DEFAULT_PLAYLIST] || []).filter(id => library.has(id));
    const seen = new Set(order);
    songs.forEach(t => { if (!seen.has(t.id)) order.push(t.id); });
    playlists[DEFAULT_PLAYLIST].trackIds = order;

    for (const name of Object.keys(playlists)) {
        if (name === DEFAULT_PLAYLIST) continue;
        const blob = await idbReq(db.transaction(['playlist_covers'], 'readonly').objectStore('playlist_covers').get(name));
        if (blob) { playlists[name].coverBlob = blob; playlists[name].cover = URL.createObjectURL(blob); }
    }

    const lastId = Number(localStorage.getItem('lastTrackId'));
    const lastList = localStorage.getItem('activePlaylistName');
    if (lastList && playlists[lastList]) activePlaylist = lastList;
    if (library.has(lastId)) {
        const own = playlists[activePlaylist].trackIds;
        playById(lastId, [...(own.includes(lastId) ? own : playlists[DEFAULT_PLAYLIST].trackIds)],
            { autoplay: false, seek: Number(localStorage.getItem('lastTime')) || 0 });
    }
    updateAlbumsFromTracks();
    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
    setTimeout(updateTrackInfoDisplay, 100);
}

// --- ВОСПРОИЗВЕДЕНИЕ ТРЕКОВ ---
function viewIds() {
    if (activeAlbum && albums[activeAlbum]) return [...albums[activeAlbum].trackIds];
    return [...(playlists[activePlaylist]?.trackIds || [])];
}

// Запускает трек. Если передан ids — это новая очередь (то, что видно на экране), иначе играем в текущей.
function playById(id, ids, { autoplay = true, seek = 0 } = {}) {
    const track = library.get(id);
    if (!track) return;
    if (ids) { queue = { ids, pos: ids.indexOf(id) }; shuffleHistory = []; }
    else queue.pos = queue.ids.indexOf(id);
    if (queue.pos < 0) queue = { ids: [id], pos: 0 };

    audio.src = track.url;
    document.getElementById('current-track-title').textContent = track.name;
    updateArtistsDisplay(track.artists || (track.artist ? [track.artist] : []));
    document.getElementById('main-cover').src = track.cover || 'assets/icons/me-question.png';
    if (seek) audio.addEventListener('loadedmetadata', () => { audio.currentTime = seek; }, { once: true });
    if (autoplay) audio.play().catch(e => console.warn('Автоплей заблокирован:', e));
    updatePlayIcon(autoplay);

    document.querySelectorAll('#songs-container .item').forEach(el => el.classList.toggle('active', Number(el.dataset.id) === id));
    localStorage.setItem('lastTrackId', id);
    localStorage.setItem('lastTime', seek || 0);
    localStorage.setItem('activePlaylistName', activePlaylist || DEFAULT_PLAYLIST);
    resetABLoop();
    updateTrackInfoDisplay();
    updateMediaSession();
}

// Совместимость: играть трек по номеру в открытом списке
function playTrack(idx, autoplay = true) {
    const ids = viewIds();
    if (ids[idx] !== undefined) playById(ids[idx], ids, { autoplay });
}

function togglePlay() {
    if (!audio.src || audio.src.includes('null')) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
    updatePlayIcon(!audio.paused);
}

function getCurrentTrackList() { return queue.ids.map(id => library.get(id)).filter(Boolean); }

function nextTrack(auto = false) {
    const n = queue.ids.length;
    if (!n) return;
    let pos;
    if (isShuffle && n > 1) {
        shuffleHistory.push(queue.pos);
        do { pos = Math.floor(Math.random() * n); } while (pos === queue.pos);
    } else {
        pos = queue.pos + 1;
        if (pos >= n) {
            if (repeatMode === 'all' || !auto) pos = 0;
            else { audio.pause(); audio.currentTime = 0; updatePlayIcon(false); return; }
        }
    }
    playById(queue.ids[pos]);
}

function prevTrack() {
    const n = queue.ids.length;
    if (!n) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const pos = (isShuffle && shuffleHistory.length) ? shuffleHistory.pop() : (queue.pos - 1 + n) % n;
    playById(queue.ids[pos]);
}

audio.onended = () => repeatMode === 'one' ? audio.play() : nextTrack(true);

audio.ontimeupdate = () => {
    if (!audio.duration) return;
    const progressPercent = (audio.currentTime / audio.duration) * 100;
    progress.value = progressPercent;
    document.getElementById('time-current').textContent = formatTime(audio.currentTime);

    const now = Date.now();
    if (now - lastMediaPositionUpdate > 1000) {
        lastMediaPositionUpdate = now;
        updateMediaPosition();
    }

    if (abLoop.active && abLoop.a !== null && abLoop.b !== null) {
        if (audio.currentTime >= abLoop.b) {
            audio.currentTime = abLoop.a;
        }
    }
};

audio.onloadedmetadata = () => {
    document.getElementById('time-total').textContent = formatTime(audio.duration);
    updateEqualizer();
    updateMediaPosition();
};

// --- УПРАВЛЕНИЕ С ЭКРАНА БЛОКИРОВКИ / ШТОРКИ УВЕДОМЛЕНИЙ (Media Session API) ---
function updateMediaSession() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const track = getCurrentTrack();
    if (!track) return;

    const artwork = track.cover
        ? [{ src: track.cover, sizes: '512x512', type: (track.coverBlob && track.coverBlob.type) || 'image/jpeg' }]
        : [{ src: new URL('assets/icons/meicon.png', location.href).href, sizes: '512x512', type: 'image/png' }];

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name || '',
            artist: (track.artists && track.artists.length) ? track.artists.join(', ') : (track.artist || ''),
            album: track.album || '',
            artwork
        });
    } catch (e) { /* не критично */ }
}

let lastMediaPositionUpdate = 0;
function updateMediaPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(audio.currentTime, audio.duration)
        });
    } catch (e) { /* не критично */ }
}

(function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
        play: () => audio.play(),
        pause: () => audio.pause(),
        previoustrack: () => prevTrack(),
        nexttrack: () => nextTrack(),
        seekbackward: (d) => { audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); },
        seekforward: (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + ((d && d.seekOffset) || 10)); },
        seekto: (d) => { if (d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime; }
    };
    Object.entries(handlers).forEach(([action, handler]) => {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* действие не поддерживается */ }
    });
})();

audio.onplay = () => {
    updateEqualizer();
    updatePlayIcon(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
};
audio.onpause = () => {
    updateEqualizer();
    updatePlayIcon(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
};

progress.oninput = () => audio.currentTime = (progress.value / 100) * audio.duration;

volumeSlider.oninput = () => {
    const val = volumeSlider.value / 100;
    audio.volume = val * val;
    localStorage.setItem('grig_volume', audio.volume);
};

// --- ИМПОРТ МЕТАДАННЫХ ТРЕКА ---
// 1. Читаем теги из файла: MP3 (ID3v2/ID3v1), FLAC, OGG/Opus, M4A/MP4.
// 2. Если в тегах чего-то нет, берём это из имени файла вида "Исполнитель - Название".
// 3. Убираем лишние знаки по краям (тире, запятые, подчёркивания) и делим строку
//    с несколькими исполнителями на отдельные имена.
// 4. Достаём встроенную обложку (APIC в MP3, PICTURE во FLAC/OGG/Opus, covr в M4A).

// По каким разделителям строка с исполнителями делится на отдельные имена:
// запятая, точка с запятой, feat. / ft. / featuring.
// Чтобы делить ещё и по "&", добавьте в конец выражения |\s+&\s+
const ARTIST_SEPARATORS = /\s*[,;]\s*|[\s(\[]+(?:feat\.?|ft\.?|featuring)\s+/i;

// Разделитель "Исполнитель - Название": тире (обычное, среднее, длинное) с пробелом хотя бы
// с одной стороны. Дефис внутри слова ("Jay-Z", "Wu-Tang") разделителем не считается.
const ARTIST_TITLE_SEPARATOR = /\s+[-–—―]\s*|\s*[-–—―]\s+|\s*[–—―]\s*/;

// Знаки, которые не должны торчать в начале и в конце названия или имени.
const EDGE_JUNK = /^[\s\-–—―_,;:|\/\\]+|[\s\-–—―_,;:|\/\\]+$/g;

function cleanTrackText(value) {
    return String(value ?? '')
        .replace(/[\u0000\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .replace(EDGE_JUNK, '')
        .trim();
}

function sameTrackText(a, b) {
    return cleanTrackText(a).toLowerCase() === cleanTrackText(b).toLowerCase();
}

// "Artist)" -> "Artist", но "(G)I-DLE" остаётся как есть
function stripUnbalancedBrackets(text) {
    let s = text;
    const count = (re) => (s.match(re) || []).length;
    while (/^[(\[]/.test(s) && count(/[(\[]/g) > count(/[)\]]/g)) s = s.slice(1);
    while (/[)\]]$/.test(s) && count(/[)\]]/g) > count(/[(\[]/g)) s = s.slice(0, -1);
    return s.trim();
}

// Строка (или массив строк) -> массив чистых уникальных имён исполнителей
function splitArtistNames(value) {
    const items = Array.isArray(value) ? value : [value];
    const result = [];
    items.forEach(item => {
        String(item ?? '').split(ARTIST_SEPARATORS).forEach(part => {
            const name = stripUnbalancedBrackets(cleanTrackText(part));
            if (name && !result.some(existing => sameTrackText(existing, name))) result.push(name);
        });
    });
    return result;
}

// "Chestikov - home" -> { artist: "Chestikov", title: "home" } (или null, если разделителя нет)
function splitArtistAndTitle(text) {
    const str = String(text ?? '');
    const match = ARTIST_TITLE_SEPARATOR.exec(str);
    if (!match) return null;
    const artist = str.slice(0, match.index);
    const title = str.slice(match.index + match[0].length);
    if (!cleanTrackText(artist) || !cleanTrackText(title)) return null;
    return { artist, title };
}

// Имя файла -> { artist, title }
function parseTrackFileName(fileName) {
    let base = String(fileName ?? '').replace(/\.[^/.]+$/, '');
    base = base.replace(/^\d{1,3}\s*(?:[.)]\s*|[-–—]\s+|_+)(?=\D)/, ''); // номер в начале: "01. ", "01 - ", "01_"
    const underscores = (base.match(/_/g) || []).length;
    const spaces = (base.match(/ /g) || []).length;
    if (underscores > spaces) base = base.replace(/_/g, ' ');               // Chestikov_-_home -> Chestikov - home
    const parts = splitArtistAndTitle(base);
    if (parts) return { artist: cleanTrackText(parts.artist), title: cleanTrackText(parts.title) };
    return { artist: '', title: cleanTrackText(base) };
}

// Итог: объединяет теги и имя файла в { title, artists[], album }
function resolveTrackInfo(fileName, tags) {
    tags = tags || {};
    const fromName = parseTrackFileName(fileName);
    let title = cleanTrackText(Array.isArray(tags.title) ? tags.title[0] : tags.title);
    let artists = splitArtistNames(tags.artist);
    const album = cleanTrackText(Array.isArray(tags.album) ? tags.album[0] : tags.album);

    if (!title) {
        title = fromName.title;
        if (!artists.length) artists = splitArtistNames(fromName.artist);
    } else {
        const parts = splitArtistAndTitle(title);
        if (parts) {
            const prefix = splitArtistNames(parts.artist);
            if (!artists.length) {
                // в теге названия записано "Исполнитель - Название"
                artists = prefix;
                title = cleanTrackText(parts.title);
            } else if (prefix.every(p => artists.some(a => sameTrackText(a, p)))) {
                // исполнитель уже указан отдельно, поэтому в названии он лишний
                title = cleanTrackText(parts.title);
            }
        } else if (!artists.length && fromName.artist && sameTrackText(fromName.title, title)) {
            artists = splitArtistNames(fromName.artist);
        }
    }

    return {
        title: title || cleanTrackText(fileName) || 'Без названия',
        artists,
        album
    };
}

// ---- Низкоуровневое чтение тегов ----
const TAG_UTF8 = new TextDecoder('utf-8');
const TAG_UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
let TAG_CP1251 = null;
try { TAG_CP1251 = new TextDecoder('windows-1251'); } catch (e) { /* нет поддержки */ }

async function tagSlice(file, start, length) {
    const end = Math.min(file.size, start + length);
    if (start >= end) return new Uint8Array(0);
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function tagAscii(bytes, start, length) {
    let s = '';
    for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

function tagU32BE(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function tagSynchsafe(b, p) {
    return ((b[p] & 0x7F) << 21) | ((b[p + 1] & 0x7F) << 14) | ((b[p + 2] & 0x7F) << 7) | (b[p + 3] & 0x7F);
}

function tagConcat(parts) {
    let total = 0;
    parts.forEach(p => { total += p.length; });
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach(p => { out.set(p, offset); offset += p.length; });
    return out;
}

function tagRemoveUnsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let j = 0;
    for (let i = 0; i < bytes.length; i++) {
        out[j++] = bytes[i];
        if (bytes[i] === 0xFF && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
}

function tagDecodeUtf16(bytes, littleEndian) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        s += String.fromCharCode(littleEndian ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]));
    }
    return s;
}

// Байты "ISO-8859-1" на деле часто бывают UTF-8 или Windows-1251 (старые русские теги).
function tagDecodeLegacy(bytes) {
    let high = 0, cyrillic = 0, run = 0, maxRun = 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 0x80) {
            high++;
            if (b >= 0xC0 || b === 0xA8 || b === 0xB8) {
                cyrillic++;
                run++;
                if (run > maxRun) maxRun = run;
            } else run = 0;
        } else run = 0;
    }
    if (high > 0) {
        try { return TAG_UTF8_STRICT.decode(bytes); } catch (e) { /* не UTF-8 */ }
        if (TAG_CP1251 && cyrillic / high >= 0.9 && maxRun >= 2) return TAG_CP1251.decode(bytes);
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

// encoding: 0 = ISO-8859-1, 1 = UTF-16 с BOM, 2 = UTF-16BE, 3 = UTF-8
function tagDecodeText(bytes, encoding) {
    if (encoding === 1) {
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return tagDecodeUtf16(bytes.subarray(2), false);
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return tagDecodeUtf16(bytes.subarray(2), true);
        return tagDecodeUtf16(bytes, true);
    }
    if (encoding === 2) return tagDecodeUtf16(bytes, false);
    if (encoding === 3) return TAG_UTF8.decode(bytes);
    return tagDecodeLegacy(bytes);
}

// Текстовый кадр ID3: первый байт — кодировка, дальше одно или несколько значений через NUL
function tagDecodeID3Text(body) {
    if (!body.length) return [];
    const encoding = body[0];
    const data = body.subarray(1);
    const wide = encoding === 1 || encoding === 2;
    const step = wide ? 2 : 1;
    const chunks = [];
    let start = 0;
    for (let i = 0; i + step <= data.length; i += step) {
        const isNul = wide ? (data[i] === 0 && data[i + 1] === 0) : data[i] === 0;
        if (isNul) {
            chunks.push(data.subarray(start, i));
            start = i + step;
        }
    }
    if (start < data.length) chunks.push(data.subarray(start));
    return chunks.map(c => tagDecodeText(c, encoding)).filter(s => s.trim());
}

const TAG_ID3_FRAMES = {
    TIT2: 'title', TT2: 'title',
    TPE1: 'artist', TP1: 'artist',
    TALB: 'album', TAL: 'album',
    TPE2: 'albumArtist', TP2: 'albumArtist'
};

// Тип картинки определяем по первым байтам: MIME в тегах бывает неверным или пустым.
function tagSniffImage(bytes) {
    if (bytes.length < 4) return null;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes[0] === 0x89 && tagAscii(bytes, 1, 3) === 'PNG') return 'image/png';
    if (tagAscii(bytes, 0, 3) === 'GIF') return 'image/gif';
    if (tagAscii(bytes, 0, 2) === 'BM') return 'image/bmp';
    if (tagAscii(bytes, 0, 4) === 'RIFF' && tagAscii(bytes, 8, 4) === 'WEBP') return 'image/webp';
    return null;
}

function tagMakeCover(bytes) {
    const mime = bytes.length >= 64 ? tagSniffImage(bytes) : null;
    return mime ? { data: bytes, mime, type: 0 } : null;
}

// Из нескольких картинок предпочитаем "лицевую обложку" (тип 3), иначе берём первую
function tagBetterCover(current, candidate) {
    if (!candidate) return current;
    if (!current) return candidate;
    return (candidate.type === 3 && current.type !== 3) ? candidate : current;
}

function tagBase64ToBytes(b64) {
    try {
        const bin = atob(String(b64).replace(/\s+/g, ''));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch (e) {
        return null;
    }
}

// Кадр APIC (ID3v2.3/2.4) или PIC (ID3v2.2)
function tagParseID3Picture(body, major) {
    if (body.length < 8) return null;
    const encoding = body[0];
    let pos = 1;
    if (major === 2) {
        pos += 3; // PIC: формат из трёх букв ("JPG", "PNG") вместо MIME
    } else {
        while (pos < body.length && body[pos] !== 0) pos++; // MIME до NUL
        pos++;
    }
    const pictureType = body[pos++];
    if (encoding === 1 || encoding === 2) { // описание в UTF-16 заканчивается двойным NUL
        while (pos + 1 < body.length && !(body[pos] === 0 && body[pos + 1] === 0)) pos += 2;
        pos += 2;
    } else {
        while (pos < body.length && body[pos] !== 0) pos++;
        pos++;
    }
    const cover = tagMakeCover(body.subarray(pos));
    return cover ? { ...cover, type: pictureType } : null;
}

// Блок METADATA_BLOCK_PICTURE (FLAC, а также Vorbis/Opus внутри base64)
function tagParseFlacPicture(data) {
    let pos = 0;
    const type = tagU32BE(data, pos); pos += 4;
    const mimeLen = tagU32BE(data, pos); pos += 4 + mimeLen;
    const descLen = tagU32BE(data, pos); pos += 4 + descLen;
    pos += 16; // ширина, высота, глубина цвета, число цветов
    const len = tagU32BE(data, pos); pos += 4;
    const cover = tagMakeCover(data.subarray(pos, pos + len));
    return cover ? { ...cover, type } : null;
}

// Возвращает { tags, end }: end — смещение, где ID3v2 заканчивается
async function tagReadID3v2(file) {
    const head = await tagSlice(file, 0, 10);
    if (head.length < 10 || tagAscii(head, 0, 3) !== 'ID3') return null;
    const major = head[3];
    const flags = head[5];
    if (major < 2 || major > 4) return null;
    const size = tagSynchsafe(head, 6);
    const end = 10 + size + ((major === 4 && (flags & 0x10)) ? 10 : 0);

    let tag = await tagSlice(file, 10, Math.min(size, 32 * 1024 * 1024));
    if ((flags & 0x80) && major < 4) tag = tagRemoveUnsync(tag);

    let pos = 0;
    if ((flags & 0x40) && major >= 3 && tag.length >= 4) {
        pos = major === 3 ? 4 + tagU32BE(tag, 0) : tagSynchsafe(tag, 0);
    }

    const idLen = major === 2 ? 3 : 4;
    const headerLen = major === 2 ? 6 : 10;
    const found = {};
    let cover = null;

    while (pos + headerLen <= tag.length) {
        if (tag[pos] === 0) break; // дальше только заполнение
        const id = tagAscii(tag, pos, idLen);
        let frameSize;
        if (major === 2) frameSize = (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5];
        else if (major === 3) frameSize = tagU32BE(tag, pos + 4);
        else frameSize = tagSynchsafe(tag, pos + 4);
        const fmt = major >= 3 ? tag[pos + 9] : 0;
        pos += headerLen;
        if (frameSize <= 0 || pos + frameSize > tag.length) break;

        let body = tag.subarray(pos, pos + frameSize);
        pos += frameSize;

        const isPicture = id === 'APIC' || id === 'PIC';
        const key = TAG_ID3_FRAMES[id];
        if (isPicture ? (cover && cover.type === 3) : (!key || found[key])) continue;

        if (major === 3) {
            if (fmt & 0xC0) continue;               // сжатие или шифрование
            if (fmt & 0x20) body = body.subarray(1); // идентификатор группы
        } else if (major === 4) {
            if (fmt & 0x0C) continue;               // сжатие или шифрование
            if (fmt & 0x40) body = body.subarray(1);
            if (fmt & 0x01) body = body.subarray(4); // индикатор длины данных
            if (fmt & 0x02) body = tagRemoveUnsync(body);
        }

        if (isPicture) {
            cover = tagBetterCover(cover, tagParseID3Picture(body, major));
            continue;
        }

        const values = tagDecodeID3Text(body);
        if (values.length) found[key] = values;
    }

    return {
        end,
        tags: {
            title: found.title,
            artist: found.artist || found.albumArtist,
            album: found.album,
            cover
        }
    };
}

async function tagReadID3v1(file) {
    if (file.size < 128) return null;
    const b = await tagSlice(file, file.size - 128, 128);
    if (tagAscii(b, 0, 3) !== 'TAG') return null;
    const field = (from, to) => {
        let end = from;
        while (end < to && b[end] !== 0) end++;
        while (end > from && b[end - 1] === 0x20) end--;
        return tagDecodeLegacy(b.subarray(from, end));
    };
    return { title: field(3, 33), artist: field(33, 63), album: field(63, 93) };
}

// Комментарии Vorbis (FLAC, OGG, Opus). Если данные обрезаны — вернёт то, что успело прочитаться.
function tagParseVorbisComments(data, pos) {
    const fields = { TITLE: [], ARTIST: [], ALBUM: [], ALBUMARTIST: [], METADATA_BLOCK_PICTURE: [] };
    const u32 = (p) => (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;

    if (pos + 4 <= data.length) {
        pos += 4 + u32(pos);              // строка-производитель
        if (pos + 4 <= data.length) {
            const count = u32(pos);
            pos += 4;
            for (let i = 0; i < count && pos + 4 <= data.length; i++) {
                const len = u32(pos);
                pos += 4;
                if (pos + len > data.length) break;
                const text = TAG_UTF8.decode(data.subarray(pos, pos + len));
                pos += len;
                const eq = text.indexOf('=');
                if (eq < 1) continue;
                const key = text.slice(0, eq).toUpperCase();
                if (fields[key]) fields[key].push(text.slice(eq + 1));
            }
        }
    }

    let cover = null;
    fields.METADATA_BLOCK_PICTURE.forEach(b64 => {
        if (cover && cover.type === 3) return;
        const bytes = tagBase64ToBytes(b64);
        if (bytes) cover = tagBetterCover(cover, tagParseFlacPicture(bytes));
    });

    return {
        title: fields.TITLE[0],
        artist: fields.ARTIST.length ? fields.ARTIST : fields.ALBUMARTIST,
        album: fields.ALBUM[0],
        cover
    };
}

async function tagReadFlac(file, offset) {
    let pos = offset + 4;
    let tags = null;
    let cover = null;
    while (pos + 4 <= file.size) {
        const h = await tagSlice(file, pos, 4);
        const isLast = (h[0] & 0x80) !== 0;
        const type = h[0] & 0x7F;
        const len = (h[1] << 16) | (h[2] << 8) | h[3];
        pos += 4;
        if (type === 4 && !tags) { // VORBIS_COMMENT
            tags = tagParseVorbisComments(await tagSlice(file, pos, Math.min(len, 8 * 1024 * 1024)), 0);
        } else if (type === 6 && !(cover && cover.type === 3)) { // PICTURE
            cover = tagBetterCover(cover, tagParseFlacPicture(await tagSlice(file, pos, len)));
        }
        pos += len;
        if (isLast) break;
    }
    if (!tags && !cover) return null;
    return { ...(tags || {}), cover: cover || (tags && tags.cover) || null };
}

// Собирает из страниц OGG первые два пакета; второй — заголовок с комментариями.
// complete = false, если буфер оборвался раньше конца пакета.
function tagOggCommentPacket(buf) {
    const packets = [];
    let current = [];
    let pos = 0;

    while (packets.length < 2 && pos + 27 <= buf.length && tagAscii(buf, pos, 4) === 'OggS') {
        const segments = buf[pos + 26];
        let dataPos = pos + 27 + segments;
        for (let i = 0; i < segments && packets.length < 2; i++) {
            const segLen = buf[pos + 27 + i];
            current.push(buf.subarray(dataPos, Math.min(dataPos + segLen, buf.length)));
            dataPos += segLen;
            if (segLen < 255) { // пакет закончился
                packets.push(tagConcat(current));
                current = [];
            }
        }
        pos = dataPos;
    }
    if (packets.length >= 2) return { packet: packets[1], complete: true };
    if (current.length) packets.push(tagConcat(current));
    return { packet: packets[1] || null, complete: false };
}

async function tagReadOgg(file) {
    // Обложка внутри комментариев может весить мегабайты, поэтому буфер растёт, пока пакет не поместится
    const limit = 16 * 1024 * 1024;
    let size = 256 * 1024;
    for (;;) {
        const buf = await tagSlice(file, 0, size);
        if (tagAscii(buf, 0, 4) !== 'OggS') return null;
        const { packet, complete } = tagOggCommentPacket(buf);
        if (complete || buf.length >= file.size || size >= limit) {
            if (!packet) return null;
            if (packet[0] === 3 && tagAscii(packet, 1, 6) === 'vorbis') return tagParseVorbisComments(packet, 7);
            if (tagAscii(packet, 0, 8) === 'OpusTags') return tagParseVorbisComments(packet, 8);
            return null;
        }
        size *= 4;
    }
}

function tagMp4Children(buf, start, end) {
    const list = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = tagU32BE(buf, pos);
        const type = tagAscii(buf, pos + 4, 4);
        let headerLen = 8;
        if (size === 1) { size = tagU32BE(buf, pos + 12); headerLen = 16; }
        else if (size === 0) size = end - pos;
        if (size < headerLen || pos + size > end) break;
        list.push({ type, start: pos + headerLen, end: pos + size });
        pos += size;
    }
    return list;
}

function tagParseMoov(moov) {
    const find = (start, end, type) => tagMp4Children(moov, start, end).find(a => a.type === type);
    const udta = find(0, moov.length, 'udta');
    if (!udta) return null;
    const meta = find(udta.start, udta.end, 'meta');
    if (!meta) return null;
    const metaBody = tagAscii(moov, meta.start + 4, 4) === 'hdlr' ? meta.start : meta.start + 4;
    const ilst = find(metaBody, meta.end, 'ilst');
    if (!ilst) return null;

    const names = { '\u00A9nam': 'title', '\u00A9ART': 'artist', 'aART': 'albumArtist', '\u00A9alb': 'album' };
    const found = {};
    let cover = null;
    tagMp4Children(moov, ilst.start, ilst.end).forEach(item => {
        if (item.type === 'covr') {
            tagMp4Children(moov, item.start, item.end).filter(a => a.type === 'data').forEach(d => {
                const c = tagMakeCover(moov.subarray(d.start + 8, d.end));
                if (c && !cover) cover = c;
            });
            return;
        }
        const key = names[item.type];
        if (!key || found[key]) return;
        const data = find(item.start, item.end, 'data');
        if (data) found[key] = TAG_UTF8.decode(moov.subarray(data.start + 8, data.end));
    });
    return { title: found.title, artist: found.artist || found.albumArtist, album: found.album, cover };
}

async function tagReadMp4(file) {
    let pos = 0;
    while (pos + 8 <= file.size) {
        const h = await tagSlice(file, pos, 16);
        let size = tagU32BE(h, 0);
        const type = tagAscii(h, 4, 4);
        let headerLen = 8;
        if (size === 1) { size = tagU32BE(h, 8) * 4294967296 + tagU32BE(h, 12); headerLen = 16; }
        else if (size === 0) size = file.size - pos;
        if (size < headerLen) return null;
        if (type === 'moov') {
            if (size > 64 * 1024 * 1024) return null;
            return tagParseMoov(await tagSlice(file, pos + headerLen, size - headerLen));
        }
        pos += size;
    }
    return null;
}

function tagHasValue(v) {
    return Array.isArray(v) ? v.some(x => String(x ?? '').trim()) : !!String(v ?? '').trim();
}

// Первое непустое значение для каждого поля
// Первое непустое значение для каждого поля
function tagMerge(...sources) {
    const out = {};
    ['title', 'artist', 'album'].forEach(key => {
        for (const src of sources) {
            if (src && tagHasValue(src[key])) { out[key] = src[key]; break; }
        }
    });
    for (const src of sources) {
        if (src && src.cover) { out.cover = src.cover; break; }
    }
    return out;
}

// Определяет формат по сигнатуре файла и возвращает { title, artist, album } (что удалось прочитать)
async function readAudioTags(file) {
    try {
        const head = await tagSlice(file, 0, 12);
        if (tagAscii(head, 0, 4) === 'OggS') return tagMerge(await tagReadOgg(file));
        if (tagAscii(head, 4, 4) === 'ftyp') return tagMerge(await tagReadMp4(file));
        if (tagAscii(head, 0, 4) === 'fLaC') return tagMerge(await tagReadFlac(file, 0));

        const id3 = await tagReadID3v2(file);
        if (id3) {
            // FLAC с ID3-тегом в начале файла
            const after = await tagSlice(file, id3.end, 4);
            if (tagAscii(after, 0, 4) === 'fLaC') return tagMerge(await tagReadFlac(file, id3.end), id3.tags);
        }
        return tagMerge(id3 && id3.tags, await tagReadID3v1(file));
    } catch (err) {
        console.warn('Не удалось прочитать теги файла:', file.name, err);
        return {};
    }
}

// Выполняет fn для всех элементов, но не больше `limit` одновременно; порядок результатов сохраняется
async function mapWithLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// --- АРХИВЫ С ТРЕКАМИ (ZIP) ---
// Архив раскрывается при добавлении музыки: из него достаются обычные аудиофайлы,
// и дальше handleFileUpload работает с ними так же, как с файлами, выбранными по одному.
// Распаковка — встроенным в браузер DecompressionStream, без внешних библиотек.
const ZIP_AUDIO_TYPES = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm'
};

function isZipFile(file) {
    return /\.zip$/i.test(file.name) || /^application\/(x-)?zip(-compressed)?$/i.test(file.type);
}

function zipInflateSupported() {
    try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
}

function decodeZipName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* не UTF-8 */ }
    // Windows часто пишет русские имена в DOS-кодировке (cp866) без флага UTF-8
    try { return new TextDecoder('ibm866').decode(bytes); } catch (e) { /* нет такой кодировки */ }
    return Array.from(bytes, b => String.fromCharCode(b)).join('');
}

// Читает список файлов из «центрального каталога» в конце архива (сам архив целиком в память не грузим)
async function readZipEntries(file) {
    const tailSize = Math.min(file.size, 22 + 0xFFFF);
    const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('это не ZIP-архив');

    const total = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        throw new Error('архивы больше 4 ГБ не поддерживаются');
    }

    const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const entries = [];
    let pos = 0;
    for (let n = 0; n < total && pos + 46 <= cd.byteLength; n++) {
        if (cd.getUint32(pos, true) !== 0x02014b50) break;
        const flags = cd.getUint16(pos + 8, true);
        const method = cd.getUint16(pos + 10, true);
        const compSize = cd.getUint32(pos + 20, true);
        const nameLen = cd.getUint16(pos + 28, true);
        const extraLen = cd.getUint16(pos + 30, true);
        const commentLen = cd.getUint16(pos + 32, true);
        const localOffset = cd.getUint32(pos + 42, true);
        const name = decodeZipName(new Uint8Array(cd.buffer, pos + 46, nameLen), flags & 0x800);
        entries.push({ name, flags, method, compSize, localOffset });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// Достаёт содержимое одного файла из архива (Blob)
async function readZipEntryData(file, entry) {
    if (entry.compSize === 0xFFFFFFFF || entry.localOffset === 0xFFFFFFFF) {
        throw new Error('ZIP64 не поддерживается');
    }
    const header = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error('повреждённый архив');
    const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const packed = file.slice(start, start + entry.compSize);

    if (entry.method === 0) return packed; // без сжатия
    if (entry.method === 8) {
        return new Response(packed.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    }
    throw new Error('неподдерживаемый способ сжатия');
}

// Возвращает { files: [File], failed: число треков, которые не удалось распаковать }
async function extractAudioFromZip(file) {
    if (!zipInflateSupported()) throw new Error('браузер не умеет распаковывать архивы, обновите его');

    const entries = await readZipEntries(file);
    const files = [];
    let failed = 0;

    for (const entry of entries) {
        if (entry.name.endsWith('/')) continue; // папка
        const parts = entry.name.split(/[\\/]/);
        const baseName = parts[parts.length - 1];
        if (!baseName || baseName.startsWith('._') || parts[0] === '__MACOSX') continue; // служебные файлы macOS

        const type = ZIP_AUDIO_TYPES[baseName.split('.').pop().toLowerCase()];
        if (!type) continue; // не аудио (обложка, .txt, .cue…)

        try {
            if (entry.flags & 1) throw new Error('файл защищён паролем');
            const blob = await readZipEntryData(file, entry);
            files.push(new File([blob], baseName, { type }));
        } catch (err) {
            console.warn('Не удалось распаковать из архива:', entry.name, err);
            failed++;
        }
    }
    return { files, failed };
}

// --- РАБОТА С ФАЙЛАМИ И БД ---
async function handleFileUpload(files) {
    if (!db) { console.error("База данных не инициализирована!"); return; }

    const picked = Array.from(files);
    document.getElementById('audio-input').value = "";
    document.getElementById('archive-input').value = "";

    // ZIP-архивы раскрываются в обычные аудиофайлы, дальше всё идёт тем же путём
    const audioFiles = [];
    const archiveProblems = [];
    let archiveCount = 0, skippedInArchives = 0;
    for (const file of picked) {
        if (isZipFile(file)) {
            archiveCount++;
            showNotification(`Распаковка: ${file.name}`);
            try {
                const { files: unpacked, failed } = await extractAudioFromZip(file);
                audioFiles.push(...unpacked);
                skippedInArchives += failed;
                if (!unpacked.length && !failed) archiveProblems.push(`В архиве «${file.name}» нет аудиофайлов`);
            } catch (err) {
                console.error('Ошибка распаковки архива', file.name, err);
                archiveProblems.push(`Не удалось открыть «${file.name}»: ${err.message}`);
            }
        } else if (file.type.startsWith('audio/')) {
            audioFiles.push(file);
        }
    }
    if (!audioFiles.length) {
        if (archiveProblems.length) showNotification(archiveProblems[0]);
        return;
    }

    // Дубликаты (то же имя и размер файла) пропускаем
    const known = new Set([...library.values()].map(t => fileKey(t.file)));
    const fresh = audioFiles.filter(f => { const k = fileKey(f); if (known.has(k)) return false; known.add(k); return true; });
    const dupes = audioFiles.length - fresh.length;
    if (!fresh.length) { showNotification('Эти треки уже есть в библиотеке'); return; }

    // Сохраняем пачками: при закрытии вкладки или нехватке места пропадает только последняя пачка
    let added = 0, errorText = '';
    for (let i = 0; i < fresh.length && !errorText; i += 25) {
        const prepared = await mapWithLimit(fresh.slice(i, i + 25), 6, async (file) => {
            const tags = await readAudioTags(file);
            const coverBlob = tags.cover ? new Blob([tags.cover.data], { type: tags.cover.mime }) : null;
            return { file, info: resolveTrackInfo(file.name, tags), coverBlob };
        });
        try {
            const saved = await new Promise((resolve, reject) => {
                const tx = db.transaction(['songs'], 'readwrite');
                const store = tx.objectStore('songs');
                const out = [];
                prepared.forEach(({ file, info, coverBlob }) => {
                    const rec = { name: info.title, artists: info.artists, album: info.album, file };
                    if (coverBlob) rec.coverBlob = coverBlob;
                    store.add(rec).onsuccess = (ev) => { rec.id = ev.target.result; out.push(rec); };
                });
                tx.oncomplete = () => resolve(out);
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
            saved.forEach(t => {
                t.url = URL.createObjectURL(t.file);
                if (t.coverBlob) t.cover = URL.createObjectURL(t.coverBlob);
                t.artist = t.artists.join(' feat. ');
                library.set(t.id, t);
                playlists[DEFAULT_PLAYLIST].trackIds.push(t.id);
            });
            added += saved.length;
            if (fresh.length > 25) showNotification(`Добавлено ${added} из ${fresh.length}`);
        } catch (err) {
            console.error('Не удалось сохранить треки', err);
            errorText = err && err.name === 'QuotaExceededError' ? 'Не хватило места в хранилище браузера' : 'Не удалось сохранить треки';
        }
    }
    savePlaylistStructure();
    updateAlbumsFromTracks();
    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
    const notes = [];
    if (dupes) notes.push(`дублей пропущено: ${dupes}`);
    if (skippedInArchives) notes.push(`не распаковано: ${skippedInArchives}`);
    showNotification(errorText ? `${errorText}. Добавлено: ${added}` : `Добавлено треков: ${added}${notes.length ? ', ' + notes.join(', ') : ''}`);
}



// --- ОБЛОЖКИ ТРЕКОВ ---
const COVER_MAX_SIZE = 1000;

// Фото с телефона весят 3–10 МБ — уменьшаем до 1000px и сохраняем как JPEG,
// чтобы не раздувать IndexedDB и не тормозить списки с миниатюрами
async function prepareCover(file) {
    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, COVER_MAX_SIZE / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        if (!blob) return file;
        return (scale < 1 || blob.size < file.size) ? blob : file;
    } catch (e) {
        console.warn('Не удалось обработать изображение, сохраняем как есть', e);
        return file;
    }
}

// Кнопка смены обложки у плеера: работает с текущим треком
function openCoverPicker() {
    if (!getCurrentTrack()) {
        showNotification('Сначала выберите трек');
        return;
    }
    document.getElementById('cover-input').click();
}

async function changeTrackCover(file) {
    const input = document.getElementById('cover-input');
    if (!file) return;

    const track = getCurrentTrack();
    if (!track) {
        input.value = '';
        showNotification('Сначала выберите трек');
        return;
    }
    if (!file.type.startsWith('image/')) {
        input.value = '';
        showNotification('Выберите файл изображения');
        return;
    }

    const blob = await prepareCover(file);
    if (track.cover) URL.revokeObjectURL(track.cover);
    track.coverBlob = blob;
    track.cover = URL.createObjectURL(blob);

    try {
        await persistTrack(track);
        refreshCurrentTrackView(track);
        updateAlbumsFromTracks();
        renderPlaylistsAndAlbums();
        renderTracksForActiveView();
        showNotification('Обложка сохранена');
    } catch (err) {
        console.error('Не удалось сохранить обложку', err);
        showNotification('Не удалось сохранить обложку');
    }
    input.value = '';
}

function changeBackground(file) {
    if (!file || !db) return;
    updateBackgroundUI(file);
    db.transaction(['settings'], 'readwrite').objectStore('settings').put(file, 'background');
    document.getElementById('bg-input').value = "";
}

function resetBackground() {
    if (!db) return;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    document.getElementById('custom-bg').style.backgroundImage = 'none';
    document.getElementById('bg-preview-box').style.backgroundImage = 'none';
    document.getElementById('bg-plus-icon').style.display = 'block';

    document.getElementById('custom-bg').style.backgroundColor = DEFAULT_COLORS.bg;

    changeMainBgColor(DEFAULT_COLORS.bg);

    db.transaction(['settings'], 'readwrite').objectStore('settings').delete('background');

    showNotification('Фоновое изображение удалено');
}

// --- МОДАЛЬНЫЕ ОКНА И НАСТРОЙКИ ---
function saveEdit() {
    if (!db) return;

    if (editTarget.type === 'create') {
        const val = document.getElementById('edit-input').value.trim();
        if (!val) return;

        if (!playlists[val] && val !== DEFAULT_PLAYLIST) {
            playlists[val] = makePlaylist(val);
            savePlaylistStructure();
        }
    } else {
        const trackName = document.getElementById('edit-track-name').value.trim();
        if (!trackName) {
            showNotification('Введите название трека');
            return;
        }

        const track = editTarget.track;
        if (!track) return;

        track.name = trackName;
        track.artists = getArtistsFromInputs();
        track.album = document.getElementById('edit-track-album').value.trim();
        track.artist = track.artists.join(' feat. ');

        const coverChanged = editTarget.pendingCover !== undefined;
        if (coverChanged) {
            if (track.cover) URL.revokeObjectURL(track.cover);
            track.coverBlob = editTarget.pendingCover; // Blob или null
            track.cover = track.coverBlob ? URL.createObjectURL(track.coverBlob) : null;
        }

        persistTrack(track).then(() => {
            updateAlbumsFromTracks();
            renderPlaylistsAndAlbums();
            renderTracksForActiveView();
            refreshCurrentTrackView(track);
            if (coverChanged) showNotification(track.cover ? 'Обложка сохранена' : 'Обложка убрана');
        }).catch(err => {
            console.error('Не удалось сохранить трек', err);
            showNotification('Не удалось сохранить изменения');
        });
    }

    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
    closeEditModal();
}

function deleteActivePlaylist(name = activePlaylist) {
    if (!db || name === DEFAULT_PLAYLIST || !playlists[name]) return;
    if (playlists[name].cover) URL.revokeObjectURL(playlists[name].cover);
    db.transaction(['playlist_covers'], 'readwrite').objectStore('playlist_covers').delete(name);
    delete playlists[name]; // треки остаются в библиотеке, дублей больше не появляется
    if (activePlaylist === name) activePlaylist = DEFAULT_PLAYLIST;
    savePlaylistStructure();
    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
    closeConfirmModal();
    closePlaylistEditModal();
}

function openMoveModal() {
    const track = getCurrentTrack();
    if (!track) { showNotification('Сначала выберите трек'); return; }
    const names = Object.keys(playlists).filter(n => n !== DEFAULT_PLAYLIST);
    if (!names.length) { showNotification('Сначала создайте плейлист'); return; }

    const mList = document.getElementById('modal-playlist-list');
    mList.innerHTML = '';
    names.forEach(name => {
        const d = document.createElement('div');
        d.className = 'modal-playlist-btn';
        d.textContent = playlists[name].name || name;
        d.onclick = () => {
            const p = playlists[name];
            closeMoveModal();
            if (p.trackIds.includes(track.id)) { showNotification('Трек уже в этом плейлисте'); return; }
            p.trackIds.push(track.id); // ссылка на трек, а не копия файла
            savePlaylistStructure(); renderPlaylists();
            if (activePlaylist === name && !activeAlbum) renderTracksForActiveView();
            showNotification(`Трек добавлен в плейлист "${p.name || name}"`);
        };
        mList.appendChild(d);
    });
    document.getElementById('move-modal').style.display = 'flex';
}

function openSettingsModal() {
    document.getElementById('settings-modal').style.display = 'flex';

    const verticalBtn = document.getElementById('orientation-vertical');
    const horizontalBtn = document.getElementById('orientation-horizontal');

    if (verticalBtn && horizontalBtn) {
        if (playerOrientation === 'horizontal') {
            verticalBtn.classList.remove('active');
            horizontalBtn.classList.add('active');
        } else {
            verticalBtn.classList.add('active');
            horizontalBtn.classList.remove('active');
        }
    }

    const displayModeSelect = document.getElementById('display-mode-select');
    if (displayModeSelect) {
        displayModeSelect.value = displayMode;
    }
}

function closeSettingsModal() {
    document.getElementById('settings-modal').style.display = 'none';
}

function openEditModal(type, old, idx = null) {
    editTarget = { type, old, idx };

    if (type === 'playlist') {
        document.getElementById('edit-modal-title').textContent = 'Переименовать плейлист';
        document.getElementById('track-edit-fields').style.display = 'none';
        document.getElementById('edit-input').style.display = 'block';
        document.getElementById('edit-input').value = old;
        document.getElementById('edit-input').placeholder = 'Название плейлиста';
    }
    document.getElementById('edit-modal').style.display = 'flex';
}

// --- РЕДАКТИРОВАНИЕ ТРЕКА (название, исполнители, альбом, обложка) ---
function openTrackEditModal(track) {
    if (!track) return;
    // pendingCover: undefined — не менять, Blob — новая обложка, null — убрать обложку
    editTarget = { type: 'track', track, pendingCover: undefined, previewUrl: null };

    document.getElementById('edit-modal-title').textContent = 'Изменить трек';
    document.getElementById('track-edit-fields').style.display = 'block';
    document.getElementById('edit-input').style.display = 'none';

    document.getElementById('edit-track-name').value = track.name || '';
    setArtistsInputs(track.artists || []);
    document.getElementById('edit-track-album').value = track.album || '';
    document.getElementById('edit-track-cover-input').value = '';
    updateEditCoverPreview();

    document.getElementById('edit-modal').style.display = 'flex';
}

function updateEditCoverPreview() {
    if (!editTarget || editTarget.type !== 'track') return;
    const img = document.getElementById('edit-track-cover-img');
    const resetBtn = document.getElementById('edit-track-cover-reset');
    let src = null;

    if (editTarget.pendingCover instanceof Blob) {
        if (editTarget.previewUrl) URL.revokeObjectURL(editTarget.previewUrl);
        editTarget.previewUrl = URL.createObjectURL(editTarget.pendingCover);
        src = editTarget.previewUrl;
    } else if (editTarget.pendingCover === undefined) {
        src = editTarget.track.cover || null;
    }

    img.src = src || 'assets/icons/me-question.png';
    resetBtn.style.display = src ? '' : 'none';
}

async function pickEditTrackCover(file) {
    if (!file || !editTarget || editTarget.type !== 'track') return;
    if (!file.type.startsWith('image/')) {
        showNotification('Выберите файл изображения');
        return;
    }
    editTarget.pendingCover = await prepareCover(file);
    document.getElementById('edit-track-cover-input').value = '';
    updateEditCoverPreview();
}

function resetEditTrackCover() {
    if (!editTarget || editTarget.type !== 'track') return;
    editTarget.pendingCover = null;
    updateEditCoverPreview();
}

function openCreatePlaylistModal() {
    editTarget = { type: 'create' };
    document.getElementById('edit-modal-title').textContent = 'Новый плейлист';
    document.getElementById('track-edit-fields').style.display = 'none';
    document.getElementById('edit-input').style.display = 'block';
    document.getElementById('edit-input').value = '';
    document.getElementById('edit-modal').style.display = 'flex';
}

function closeEditModal() {
    if (editTarget && editTarget.previewUrl) URL.revokeObjectURL(editTarget.previewUrl);
    document.getElementById('edit-track-cover-input').value = '';
    document.getElementById('edit-modal').style.display = 'none';
    document.getElementById('track-edit-fields').style.display = 'none';
    document.getElementById('edit-input').style.display = 'block';
    document.getElementById('artists-container').innerHTML = '';
}

function openDeleteConfirmModal(name) {
    // из окна редактирования плейлиста приходит его имя; из боковой панели — удаляем активный
    const target = (typeof name === 'string' && name) ? name : activePlaylist;
    if (target === DEFAULT_PLAYLIST || !playlists[target]) {
        showNotification('Нельзя удалить плейлист "Все треки"');
        return;
    }
    askConfirm({
        text: `Удалить "${playlists[target].name || target}" со всеми треками?`,
        onConfirm: () => deleteActivePlaylist(target)
    });
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').style.display = 'none';
}

function closeMoveModal() {
    document.getElementById('move-modal').style.display = 'none';
}

function openCheckUpdates() {
    document.getElementById('CheckUpdates').style.display = 'flex';
}

function closeCheckUpdates() {
    document.getElementById('CheckUpdates').style.display = 'none';
}

// --- ФУНКЦИИ ДЛЯ РЕДАКТИРОВАНИЯ ПЛЕЙЛИСТОВ ---
function openPlaylistEditModal(playlistName) {
    const playlist = playlists[playlistName];
    if (!playlist) return;

    editTarget = { type: 'playlist', old: playlistName };

    document.getElementById('playlist-edit-name').value = playlist.name || playlistName;

    const coverImg = document.getElementById('playlist-edit-cover-img');
    if (playlist.cover) {
        coverImg.src = playlist.cover;
    } else {
        coverImg.src = 'assets/icons/me-question.png';
    }

    document.getElementById('playlist-edit-modal').style.display = 'flex';
}

function closePlaylistEditModal() {
    document.getElementById('playlist-edit-modal').style.display = 'none';
    document.getElementById('playlist-cover-input').value = '';
}

function savePlaylistEdit() {
    const newName = document.getElementById('playlist-edit-name').value.trim();
    const oldName = editTarget.old;
    if (!newName) { showNotification('Введите название плейлиста'); return; }
    if (oldName === DEFAULT_PLAYLIST) {
        showNotification('Нельзя редактировать плейлист "Все треки"');
        closePlaylistEditModal();
        return;
    }
    if (newName !== oldName) {
        if (playlists[newName]) { showNotification('Плейлист с таким именем уже существует'); return; }
        const p = playlists[oldName];
        p.name = newName;
        playlists = Object.fromEntries(Object.entries(playlists).map(([k, v]) => [k === oldName ? newName : k, v]));
        if (p.coverBlob && db) {
            const st = db.transaction(['playlist_covers'], 'readwrite').objectStore('playlist_covers');
            st.delete(oldName); st.put(p.coverBlob, newName);
        }
        if (activePlaylist === oldName) activePlaylist = newName;
        editTarget.old = newName;
    }
    savePlaylistStructure();
    renderPlaylists();
    closePlaylistEditModal();
    showNotification('Плейлист сохранён');
}

function changePlaylistCover(file) {
    if (!file || !editTarget || !editTarget.old) return;

    const playlistName = editTarget.old;
    const playlist = playlists[playlistName];

    if (!playlist) return;

    if (db && db.objectStoreNames.contains('playlist_covers')) {
        const tx = db.transaction(['playlist_covers'], 'readwrite');
        const store = tx.objectStore('playlist_covers');
        store.put(file, playlistName).onsuccess = () => {
            console.log('Обложка плейлиста сохранена');
        };
    }

    if (playlist.cover) URL.revokeObjectURL(playlist.cover);
    const coverUrl = URL.createObjectURL(file);

    document.getElementById('playlist-edit-cover-img').src = coverUrl;

    playlist.cover = coverUrl;
    playlist.coverBlob = file;

    savePlaylistStructure();
    renderPlaylists();

    showNotification('Обложка плейлиста сохранена');
}

// --- ОБРАБОТЧИКИ СОБЫТИЙ ---
function toggleShuffle() {
    isShuffle = !isShuffle;
    document.getElementById('shuffle-btn').classList.toggle('active', isShuffle);
}

function toggleRepeat() {
    repeatMode = { off: 'all', all: 'one', one: 'off' }[repeatMode] || 'off';
    isRepeat = repeatMode !== 'off';
    localStorage.setItem('repeatMode', repeatMode);
    applyRepeatUI();
}
function applyRepeatUI() {
    const b = document.getElementById('repeat-btn');
    if (!b) return;
    b.classList.toggle('active', repeatMode !== 'off');
    b.dataset.mode = repeatMode;
    b.title = { off: 'Повтор выключен', all: 'Повтор списка', one: 'Повтор трека' }[repeatMode];
}

document.getElementById('audio-input').onchange = (e) => handleFileUpload(e.target.files);
document.getElementById('archive-input').onchange = (e) => handleFileUpload(e.target.files);

if (dz) {
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag-over'); };
    dz.ondragleave = () => dz.classList.remove('drag-over');
    dz.ondrop = (e) => {
        e.preventDefault();
        dz.classList.remove('drag-over');
        handleFileUpload(e.dataTransfer.files);
    };
}

// Обработка клавиш
document.addEventListener('keydown', (e) => {
    if (!audio.src || audio.src.includes('null')) return;

    if (e.altKey && e.code === 'KeyA') {
        e.preventDefault();
        if (!abLoop.active) {
            abLoop.a = audio.currentTime;
            showNotification(`Точка A: ${formatTime(abLoop.a)}`);
            updateABLoopUI();
            updateMenuItems();
        }
    }

    if (e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        if (abLoop.a !== null && !abLoop.active) {
            if (audio.currentTime > abLoop.a) {
                abLoop.b = audio.currentTime;
                abLoop.active = true;
                showNotification(`A-B loop активирован: ${formatTime(abLoop.a)} - ${formatTime(abLoop.b)}`);
                updateABLoopUI();
                updateMenuItems();
            } else {
                showNotification('Точка B должна быть позже точки A');
                abLoop.a = null;
            }
        }
    }

    if (e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        resetABLoop();
        showNotification('A-B loop сброшен');
        updateMenuItems();
    }
});

// --- МОБИЛЬНАЯ НАВИГАЦИЯ ---
function showMainPlayer() {
    closeDrawers();
}

function updateMobileNavActive() {
    const leftBtn = document.getElementById('mobile-nav-left');
    const playerBtn = document.getElementById('mobile-nav-player');
    const rightBtn = document.getElementById('mobile-nav-right');
    if (!leftBtn || !playerBtn || !rightBtn) return;

    const mobile = isMobileView();
    leftBtn.classList.toggle('active', mobile && isSidebarOpen);
    rightBtn.classList.toggle('active', mobile && isTracksOpen);
    playerBtn.classList.toggle('active', !(mobile && (isSidebarOpen || isTracksOpen)));
}

// Переход между мобильным и десктопным режимом (поворот экрана, ресайз окна)
function onViewModeChange() {
    closeDrawers();
    renderPlaylistsAndAlbums();
    renderTracksForActiveView();
}
if (MOBILE_QUERY.addEventListener) {
    MOBILE_QUERY.addEventListener('change', onViewModeChange);
} else if (MOBILE_QUERY.addListener) {
    MOBILE_QUERY.addListener(onViewModeChange);
}

// Окно «Добавить музыку»: файлы по одному или архив — оба варианта идут в один handleFileUpload
function openAddMusicModal() {
    document.getElementById('add-music-modal').style.display = 'flex';
}

function closeAddMusicModal() {
    document.getElementById('add-music-modal').style.display = 'none';
}

function pickAudioFiles() {
    closeAddMusicModal();
    document.getElementById('audio-input').click();
}

function pickArchive() {
    closeAddMusicModal();
    document.getElementById('archive-input').click();
}

function openMoreActionsModal() {
    document.getElementById('more-actions-modal').style.display = 'flex';
}

function closeMoreActionsModal() {
    document.getElementById('more-actions-modal').style.display = 'none';
}

// --- ОБРАБОТКА СВАЙПОВ ---
// Свайп вправо на плеере — библиотека, влево — треки. Открытую панель закрывает свайп в её сторону.
let swipeStart = null;

document.addEventListener('touchstart', function(e) {
    swipeStart = null;
    if (!isMobileView() || e.touches.length !== 1) return;
    // не мешаем ползункам, полям ввода и модальным окнам
    if (e.target.closest('input, textarea, select, .modal-overlay, .dropdown-menu')) return;
    const t = e.touches[0];
    swipeStart = { x: t.clientX, y: t.clientY, time: Date.now() };
}, { passive: true });

document.addEventListener('touchend', function(e) {
    if (!swipeStart) return;
    const start = swipeStart;
    swipeStart = null;
    if (!isMobileView()) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    // только явный горизонтальный жест, не слишком медленный
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - start.time > 700) return;

    if (isSidebarOpen) {
        if (dx < 0) closeDrawers();
    } else if (isTracksOpen) {
        if (dx > 0) closeDrawers();
    } else if (e.target.closest('.player-center')) {
        setDrawer(dx > 0 ? 'sidebar' : 'tracks', true);
    }
}, { passive: true });

document.addEventListener('touchcancel', () => { swipeStart = null; }, { passive: true });

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && (isSidebarOpen || isTracksOpen)) closeDrawers();
});

// --- ИНИЦИАЛИЗАЦИЯ ---
window.addEventListener('load', function() {
    setTimeout(() => {
        const accentColor = localStorage.getItem('grig_accent_color') || DEFAULT_COLORS.accent;
        const panelColor = localStorage.getItem('grig_panel_bg_color') || DEFAULT_COLORS.panel;
        const bgColor = localStorage.getItem('grig_main_bg_color') || DEFAULT_COLORS.bg;

        document.getElementById('accent-color-input').value = rgbToHex(accentColor);
        document.getElementById('panel-color-input').value = rgbToHex(panelColor);
        document.getElementById('bg-color-input').value = rgbToHex(bgColor);

        const displayModeSelect = document.getElementById('display-mode-select');
        if (displayModeSelect) {
            displayModeSelect.value = displayMode;
        }

        setPlayerOrientation(localStorage.getItem('playerOrientation') || 'vertical');
        applyPanelStates();

        if (!document.getElementById('sleep-timer-btn')) {
            const timerBtn = document.createElement('button');
            timerBtn.id = 'sleep-timer-btn';
            timerBtn.style.display = 'none';
            document.body.appendChild(timerBtn);
        }

        if (!document.getElementById('ab-loop-btn')) {
            const abBtn = document.createElement('button');
            abBtn.id = 'ab-loop-btn';
            abBtn.style.display = 'none';
            document.body.appendChild(abBtn);
        }

        updateMobileNavActive();
    }, 100);
});

// --- НОВОЕ: сохранение позиции, ошибки воспроизведения, горячие клавиши, контраст акцента ---
(function () {
    let lastSave = 0;
    audio.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastSave > 3000 && getCurrentTrack()) { lastSave = now; localStorage.setItem('lastTime', audio.currentTime.toFixed(1)); }
    });

    let errorStreak = 0;
    audio.addEventListener('playing', () => { errorStreak = 0; });
    audio.addEventListener('error', () => {
        if (!getCurrentTrack()) return;
        showNotification('Не удалось воспроизвести трек');
        if (++errorStreak < queue.ids.length) setTimeout(() => nextTrack(true), 800);
    });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, button, [contenteditable]')) return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        else if (e.code === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
        else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
        else if (e.code === 'KeyM') audio.muted = !audio.muted;
    });

    // Цвет текста на акцентном фоне подбирается по яркости, чтобы светлый акцент не давал «белое на белом»
    const baseAccent = changeAccentColor;
    changeAccentColor = function (c) {
        baseAccent(c);
        try {
            const m = String(c).startsWith('#') ? String(c).slice(1).match(/../g).map(h => parseInt(h, 16)) : String(c).match(/\d+/g).slice(0, 3).map(Number);
            document.documentElement.style.setProperty('--on-accent', (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) > 160 ? '#111' : '#fff');
        } catch (e) { /* не критично */ }
    };

    applyRepeatUI();
    // Просим браузер не удалять библиотеку при нехватке места
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();

// --- PWA: офлайн-режим и установка (service worker работает только на HTTPS или localhost) ---
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker не зарегистрирован:', err));
    });
}