
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, getDoc, updateDoc, doc, deleteDoc, query, orderBy, where, limit, serverTimestamp, runTransaction, writeBatch } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";



const firebaseConfig = {
  apiKey: "AIzaSyB47PUgkF89tiBj7U-WgUbUbMPTGP6ANNQ",
  authDomain: "pos-system-d5ef4.firebaseapp.com",
  projectId: "pos-system-d5ef4",
  storageBucket: "pos-system-d5ef4.firebasestorage.app",
  messagingSenderId: "836513506112",
  appId: "1:836513506112:web:a67546bfbaea4fb412d0a5"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const mojibakeMarkerPattern = /[ÃÂâð]/;

function sanitizeMojibakeString(value) {
  if (typeof value !== 'string' || !mojibakeMarkerPattern.test(value)) return value;
  return value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeElementText(el) {
  if (!el) return;
  ['placeholder', 'title', 'aria-label'].forEach((attr) => {
    const val = el.getAttribute && el.getAttribute(attr);
    const clean = sanitizeMojibakeString(val);
    if (clean !== val && clean != null) {
      el.setAttribute(attr, clean);
    }
  });

  if (typeof el.value === 'string') {
    const cleanValue = sanitizeMojibakeString(el.value);
    if (cleanValue !== el.value) {
      el.value = cleanValue;
    }
  }
}

function sanitizeVisibleDom(root = document.body) {
  if (!root) return;

  const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [root];
  elements.forEach((el) => sanitizeElementText(el));

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const clean = sanitizeMojibakeString(node.nodeValue);
    if (clean !== node.nodeValue) {
      node.nodeValue = clean;
    }
  }
}

function setupMojibakeGuard() {
  sanitizeVisibleDom();

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData' && mutation.target) {
        const clean = sanitizeMojibakeString(mutation.target.nodeValue);
        if (clean !== mutation.target.nodeValue) {
          mutation.target.nodeValue = clean;
        }
        return;
      }

      if (mutation.target && mutation.type === 'attributes') {
        sanitizeElementText(mutation.target);
      }

      mutation.addedNodes.forEach((addedNode) => {
        if (addedNode.nodeType === Node.TEXT_NODE) {
          const clean = sanitizeMojibakeString(addedNode.nodeValue);
          if (clean !== addedNode.nodeValue) {
            addedNode.nodeValue = clean;
          }
        } else if (addedNode.nodeType === Node.ELEMENT_NODE) {
          sanitizeVisibleDom(addedNode);
        }
      });
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label', 'value']
  });
}


class OfflineManager {
  constructor() {
    this.dbName = 'pos_offline_db';
    this.storeName = 'sync_queue';
    this.db = null;
    this.initDB();
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
        this.sync();
      };
      request.onerror = (e) => reject(e);
    });
  }

  async addToQueue(type, collectionName, payload, docId = null) {
    if (!this.db) await this.initDB();
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const entry = {
      type,
      collection: collectionName,
      payload,
      docId,
      timestamp: Date.now()
    };
    return new Promise((resolve, reject) => {
      const request = store.add(entry);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  async sync() {
    if (!navigator.onLine || !this.db) return;
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.getAll();

    request.onsuccess = async () => {
      const items = request.result;
      if (items.length === 0) return;

      console.log(`[OfflineManager] Syncing ${items.length} items...`);
      for (const item of items) {
        try {
          if (item.type === 'add') {
            await addDoc(collection(db, item.collection), item.payload);
          } else if (item.type === 'update') {
            await updateDoc(doc(db, item.collection, item.docId), item.payload);
          } else if (item.type === 'delete') {
            await deleteDoc(doc(db, item.collection, item.docId));
          }

          const delTrans = this.db.transaction([this.storeName], 'readwrite');
          delTrans.objectStore(this.storeName).delete(item.id);
        } catch (err) {
          console.error('[OfflineManager] Sync failed for item', item, err);

        }
      }
      console.log('[OfflineManager] Sync completed.');
    };
  }
}

const offlineManager = new OfflineManager();
window.syncData = () => offlineManager.sync();


async function safeWrite(action, collectionName, payload, docId = null) {
  if (navigator.onLine) {
    try {
      if (action === 'add') return await addDoc(collection(db, collectionName), payload);
      if (action === 'update') return await updateDoc(doc(db, collectionName, docId), payload);
      if (action === 'delete') return await deleteDoc(doc(db, collectionName, docId));
    } catch (err) {
      console.warn('Online write failed, queuing...', err);
      await offlineManager.addToQueue(action, collectionName, payload, docId);
    }
  } else {
    console.log('Offline: Queuing write...');
    await offlineManager.addToQueue(action, collectionName, payload, docId);
  }
}


const sfx = {
  click: new Audio('sounds/click.mp3'),
  add: new Audio('sounds/add.mp3'),
  delete: new Audio('sounds/delete.mp3'),
  success: new Audio('sounds/success.mp3'),
  chaching: new Audio('sounds/chaching.mp3'),
};

Object.values(sfx).forEach(a => {
  a.preload = 'auto';
  a.volume = 0.8;
});


function playSfx(sound) {
  if (!soundEnabled) return;
  try {
    sfx[sound].currentTime = 0;
    sfx[sound].play();
  } catch (e) {
    console.warn("Audio blocked until user action");
  }
}




let products = [];
let cart = [];
let currentCategory = "All";
let currentShift = null;
let currentSubtotal = 0;


let lendingCart = [];
let currentLendingCategory = "All";


let categories = [];
let isColorMode = false;
const availableColors = ['#f6f7fb', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#4b0082', '#9b59b6'];
const searchState = {
  sales: "",
  lending: "",
  stocks: ""
};

const historyFilters = { startDate: null, endDate: null, cashier: 'all' };


let currentUserRole = null;
let currentUsername = null;
let currentEmployeeName = null;


const cleanStr = (s) => String(s || '').toLowerCase().trim();


async function loadCategories() {
  try {
    const q = query(collection(db, 'categories'), orderBy('name'));
    const snap = await getDocs(q);
    categories = [];
    snap.forEach(d => categories.push({ id: d.id, ...d.data() }));


    if (categories.length === 0) {
      const defaults = ['Vegetables', 'Frozen Foods', 'Groceries'];
      for (const cat of defaults) {
        await safeWrite('add', 'categories', { name: cat });
      }

      const q2 = query(collection(db, 'categories'), orderBy('name'));
      const snap2 = await getDocs(q2);
      snap2.forEach(d => categories.push({ id: d.id, ...d.data() }));
    }

    renderCategoriesUI();
    renderLendingCategoriesUI();
    renderCategoriesManagement();
    updateAddProductCategorySelect();
    renderProducts();
    renderLendingProducts();
    if (document.getElementById('productsPage')?.style.display !== 'none') renderProductsEditor();
  } catch (err) {
    console.error('Failed to load categories', err);
  }
}

async function setCategoryColor(catId, color) {
  try {
    await safeWrite('update', 'categories', { color }, catId);
    await loadCategories();
  } catch (err) {
    console.error('Failed to update category color', err);
  }
}

function cycleCategoryColor(catId) {
  const cat = categories.find(c => c.id === catId);
  if (!cat) return;
  const currentIndex = availableColors.indexOf(cat.color || '#f6f7fb');
  const nextIndex = (currentIndex + 1) % availableColors.length;
  setCategoryColor(catId, availableColors[nextIndex]);
}

async function addCategory(name) {
  const n = (name || '').trim();
  if (!n) return alert('Category name required');

  if (categories.some(c => c.name.toLowerCase() === n.toLowerCase())) {
    return alert('Category already exists');
  }
  try {
    await safeWrite('add', 'categories', { name: n });
    await loadCategories();
    alert('Category added');
  } catch (err) {
    console.error('Failed to add category', err);
    alert('Failed to add category');
  }
}

async function deleteCategory(id) {
  if (!confirm('Delete this category? Products in this category will remain but be uncategorized (or mapped incorrectly).')) return;
  try {
    await safeWrite('delete', 'categories', null, id);
    await loadCategories();
  } catch (err) {
    console.error('Failed to delete category', err);
  }
}

window.deleteCategory = deleteCategory;


function renderCategoriesUI() {
  const div = document.getElementById('categories');
  if (!div) return;
  div.innerHTML = '';


  const allBtn = document.createElement('button');
  allBtn.className = 'category-btn';
  allBtn.innerText = 'All';
  allBtn.onclick = () => setCategory('All');
  if (currentCategory === 'All') allBtn.classList.add('active');
  div.appendChild(allBtn);

  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerText = c.name;
    if (c.color) {
      btn.style.background = c.color;
      btn.style.borderColor = c.color;

    }
    btn.onclick = () => setCategory(c.name);
    if (currentCategory === c.name) btn.classList.add('active');
    div.appendChild(btn);
  });
}


function renderLendingCategoriesUI() {
  const div = document.getElementById('lending-categories');
  if (!div) return;
  div.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'category-btn';
  allBtn.innerText = 'All';
  allBtn.onclick = () => setLendingCategory('All');
  if (currentLendingCategory === 'All') allBtn.classList.add('active');
  div.appendChild(allBtn);

  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.innerText = c.name;
    if (c.color) {
      btn.style.background = c.color;
      btn.style.borderColor = c.color;
    }
    btn.onclick = () => setLendingCategory(c.name);
    if (currentLendingCategory === c.name) btn.classList.add('active');
    div.appendChild(btn);
  });
}


function renderCategoriesManagement() {
  const div = document.getElementById('categories-management-list');
  if (!div) return;
  div.innerHTML = '';

  categories.forEach(c => {
    const chip = document.createElement('span');
    chip.className = 'category-btn';
    if (c.color) {
      chip.style.background = c.color;
      chip.style.borderColor = c.color;
    }
    chip.style.cursor = isColorMode ? 'pointer' : 'default';
    chip.innerHTML = `${c.name} <button class="delete-cat" onclick="deleteCategory('${c.id}')"></button>`;
    if (isColorMode) {
      chip.onclick = (e) => {
        if (e.target.classList.contains('delete-cat')) return;
        cycleCategoryColor(c.id);
      };
    }
    div.appendChild(chip);
  });
}

const toggleColorModeBtn = document.getElementById('toggle-color-mode');
if (toggleColorModeBtn) {
  toggleColorModeBtn.onclick = () => {
    isColorMode = !isColorMode;
    document.getElementById('color-mode-status').style.display = isColorMode ? 'inline' : 'none';
    toggleColorModeBtn.classList.toggle('active', isColorMode);
    renderCategoriesManagement();
  };
}

function updateAddProductCategorySelect() {
  const sel = document.getElementById('new-product-category');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">Select Category</option>';
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.innerText = c.name;
    sel.appendChild(opt);
  });
  if (currentVal) sel.value = currentVal;
}


let soundEnabled = true;
const soundFiles = {};


function loadSounds() {
  const sounds = ['click.mp3', 'add.mp3', 'delete.mp3', 'success.mp3', 'chaching.mp3'];
  sounds.forEach(sound => {
    const audio = new Audio(`sounds/${sound}`);
    audio.preload = 'auto';
    soundFiles[sound.replace('.mp3', '')] = audio;
  });
}

function playSound(soundName) {
  if (!soundEnabled || !soundFiles[soundName]) return;
  try {
    soundFiles[soundName].currentTime = 0;
    soundFiles[soundName].play();
  } catch (error) {
    console.warn('Failed to play sound:', soundName, error);
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  saveSoundSettings();
  updateSoundToggleUI();
}

function saveSoundSettings() {
  localStorage.setItem('soundEnabled', soundEnabled);
}

function loadSoundSettings() {
  const saved = localStorage.getItem('soundEnabled');
  if (saved !== null) {
    soundEnabled = saved === 'true';
  }
  updateSoundToggleUI();
}

function updateSoundToggleUI() {
  const toggleBtn = document.getElementById('sound-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = '';
    toggleBtn.setAttribute('aria-label', soundEnabled ? 'sound on' : 'sound off');
    toggleBtn.setAttribute('title', soundEnabled ? 'Sound ON' : 'Sound OFF');
    toggleBtn.classList.toggle('is-muted', !soundEnabled);
  }
}


function formatCurrency(amount) {
  return 'PHP ' + Number(amount || 0).toFixed(2);
}
function toDisplayDate(value) {
  if (!value) return new Date();
  if (value.toDate && typeof value.toDate === 'function') return value.toDate();
  return value instanceof Date ? value : new Date(value);
}

async function initShift() {

  try {
    const q = query(collection(db, 'shifts'), where('status', '==', 'open'));
    const qSnap = await getDocs(q);
    if (!qSnap.empty) {
      let latest = null;
      qSnap.forEach(snap => {
        const d = snap.data() || {};
        const ts = d.startTime && d.startTime.toDate ? d.startTime.toDate() : (d.startTime || new Date(0));
        if (!latest || ts > latest.startTime) {
          latest = { id: snap.id, startTime: ts, status: d.status, totalIncome: Number(d.totalIncome || d.totalSales || 0), cashierName: d.cashierName || d.openedBy || '' };
        }
      });
      currentShift = latest || null;
    } else {
      currentShift = null;
    }
  } catch (err) {
    console.error('Failed to init shift', err);
    currentShift = null;
  }
  updateShiftUI();

  loadSalesSummary();
}

async function endCurrentShift() {

  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    return alert('No open shift to end.');
  }

  if (!confirm('Are you sure you want to end the current shift?')) return;

  try {

    const q = query(collection(db, 'sales'), where('shiftId', '==', currentShift.id));
    const qSnap = await getDocs(q);
    let sum = 0;
    qSnap.forEach(snap => { const s = snap.data() || {}; sum += Number(s.total || 0); });


    await safeWrite('update', 'shifts', { totalIncome: Number(sum.toFixed(2)), endTime: new Date(), status: 'closed' }, currentShift.id);


    currentShift.status = 'closed';
    currentShift.endTime = new Date();
    currentShift.totalIncome = Number(sum.toFixed(2));
    updateShiftUI();

    loadSalesSummary();

    loadCashiersList();
    loadCashiersDropdown();

    alert('Shift ended. Total income: ' + formatCurrency(sum));
  } catch (err) {
    console.error('Failed to close shift', err);
    alert('Failed to close shift. Check console for details.');
  }
}

function updateShiftUI() {
  const ids = ['cashier-shift-info', 'admin-shift-info', 'current-shift-info'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (currentShift && currentShift.status === 'open') {
      const ts = currentShift.startTime && currentShift.startTime.toDate ? currentShift.startTime.toDate() : (currentShift.startTime || new Date());
      el.innerText = `Shift OPEN - started ${new Date(ts).toLocaleString()} - Cashier: ${currentShift.cashierName || currentShift.openedBy || 'Unknown'} - Sales: ${formatCurrency(Number(currentShift.totalIncome || currentShift.totalSales || 0))}`;
    } else {
      el.innerText = 'No open shift';
    }
  });


  ['start-shift-btn-cashier', 'start-shift-btn-admin'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.innerText = 'Start New Shift';
    if (b) b.disabled = !!(currentShift && currentShift.status === 'open');
  });

  ['end-shift-btn-cashier', 'end-shift-btn-admin'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = (currentShift && currentShift.status === 'open') ? '' : 'none';
  });


  updateCheckoutButtonState();


  const cashierPageEl = document.getElementById('cashierPage');
  if (cashierPageEl && cashierPageEl.style.display !== 'none' && currentUserRole === 'cashier') {
    try { if (typeof loadMyShifts === 'function') loadMyShifts(); } catch (err) { console.error('loadMyShifts failed', err); }
  }
}

async function startNewShift() {

  const startBtns = ['start-shift-btn-cashier', 'start-shift-btn-admin'];
  startBtns.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = true;
  });

  const reEnableButtons = () => {
    startBtns.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {

        if (!currentShift || currentShift.status !== 'open') {
          btn.disabled = false;
        }
      }
    });
  };


  if (currentShift && currentShift.id && currentShift.status === 'open') {
    alert('A shift is already open locally. Please end the current shift before starting a new one.');
    reEnableButtons();
    return;
  }


  let cashierName = null;
  if (currentUserRole === 'admin') {
    cashierName = 'CEO';
  } else {
    cashierName = currentEmployeeName || currentUsername || prompt('Enter cashier name for this shift (required)');
    if (!cashierName || !cashierName.trim()) {
      alert('Shift start cancelled: cashier name is required');
      reEnableButtons();
      return;
    }
    cashierName = cashierName.trim();
  }


  try {
    if (!navigator.onLine) {
      throw new Error('Internet connection is required to start a shift to prevent duplicates.');
    }

    await runTransaction(db, async (transaction) => {



      const q = query(collection(db, 'shifts'),
        where('cashierName', '==', cashierName),
        where('status', '==', 'open'),
        limit(1));

      const qSnap = await getDocs(q);

      if (!qSnap.empty) {
        throw new Error('ALREADY_ACTIVE');
      }


      const newShiftRef = doc(collection(db, 'shifts'));
      const shiftData = {
        startTime: new Date(),
        status: 'open',
        endTime: null,
        cashierName: cashierName,
        totalIncome: 0
      };

      transaction.set(newShiftRef, shiftData);


      currentShift = { id: newShiftRef.id, ...shiftData };
    });

    playSfx('success');
    updateShiftUI();

    document.getElementById('items-sold-tbody').innerHTML = '';
    loadSalesSummary();

    loadCashiersList();
    loadCashiersDropdown();
    alert('Shift started');

  } catch (err) {
    if (err.message === 'ALREADY_ACTIVE') {
      alert(`You already have an active shift as "${cashierName}". Please end it before starting a new one.`);
    } else {
      console.error('Failed to start shift', err);
      alert('Failed to start shift: ' + err.message);
    }
    reEnableButtons();
  }
}

let loadProductsInFlight = null;

async function loadProducts() {
  if (loadProductsInFlight) return loadProductsInFlight;

  loadProductsInFlight = (async () => {
    const querySnapshot = await getDocs(collection(db, "products"));
    const loaded = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data() || {};
      loaded.push({
        id: doc.id,
        name: data.name,
        price: Number(data.price),
        capital: Number(data.capital || 0),
        profit: Number(data.profit || 0),
        category: (data.category || "").trim(),
        unit: data.unit,
        stock: Number(data.stock || 0),
        barcode: (data.barcode || "").trim(),
        expirationDates: Array.isArray(data.expirationDates) ? data.expirationDates.map(e => ({ date: e.date, qty: Number(e.qty || 0) })) : []
      });
    });
    products = loaded;
    renderProducts();
    checkLowStock();
    checkExpiringProducts();
  })();

  try {
    await loadProductsInFlight;
  } finally {
    loadProductsInFlight = null;
  }
}

let _lowStockAlertItems = [];
let _expiringAlertItems = [];

function checkLowStock() {
  const threshold = 5;
  const lowStockProducts = products.filter(p => p.stock <= threshold);
  _lowStockAlertItems = lowStockProducts.map(p => ({
    type: 'low-stock',
    product: p,
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    html: `<strong>${p.name}</strong>: Only <strong>${Number(p.stock).toFixed(2)}</strong> ${p.unit} left!`
  }));
  renderAlertsUI();
}

const EXPIRY_WARNING_DAYS = 7;

function checkExpiringProducts() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const warnDate = new Date();
  warnDate.setDate(warnDate.getDate() + EXPIRY_WARNING_DAYS);
  const warnStr = warnDate.toISOString().slice(0, 10);

  const items = [];
  products.forEach(p => {
    (p.expirationDates || []).forEach(entry => {
      if (!entry || !entry.date) return;
      const qty = Number(entry.qty || 0);
      if (entry.date < todayStr) {
        items.push({
          type: 'expired',
          product: p,
          date: entry.date,
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
          html: `<strong>${p.name}</strong> ${qty > 0 ? '(' + qty + ' ' + p.unit + ') ' : ''}<span style="color:var(--danger)">expired</span> on <strong>${entry.date}</strong>!`
        });
      } else if (entry.date <= warnStr) {
        items.push({
          type: 'expiring-soon',
          product: p,
          date: entry.date,
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
          html: `<strong>${p.name}</strong> ${qty > 0 ? '(' + qty + ' ' + p.unit + ') ' : ''}expires on <strong>${entry.date}</strong>`
        });
      }
    });
  });

  items.sort((a, b) => a.date.localeCompare(b.date));
  _expiringAlertItems = items;
  renderAlertsUI();
}

function getExpiryBadgeHtml(p) {
  const entries = (p.expirationDates || []).filter(e => e && e.date);
  if (entries.length === 0) return '';
  const todayStr = new Date().toISOString().slice(0, 10);
  const warnDate = new Date();
  warnDate.setDate(warnDate.getDate() + EXPIRY_WARNING_DAYS);
  const warnStr = warnDate.toISOString().slice(0, 10);
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const tags = sorted.map(e => {
    let cls = 'pec-expiry-ok';
    let label = 'Exp: ' + e.date;
    if (e.date < todayStr) {
      cls = 'pec-expiry-expired';
      label = 'Expired: ' + e.date;
    } else if (e.date <= warnStr) {
      cls = 'pec-expiry-warn';
      label = 'Exp soon: ' + e.date;
    }
    const qty = Number(e.qty || 0);
    return `<span class="pec-expiry-tag ${cls}">${label}${qty > 0 ? ' (Qty: ' + qty + ')' : ''}</span>`;
  });
  return tags.join('');
}

function renderAlertsUI() {
  const allItems = [..._expiringAlertItems, ..._lowStockAlertItems];
  const badge = document.getElementById('notif-badge');
  const modalList = document.getElementById('notif-modal-list');
  const modalEmpty = document.getElementById('notif-modal-empty');

  const buildItems = (container) => {
    container.innerHTML = '';
    allItems.forEach(item => {
      const p = item.product;
      const div = document.createElement('div');
      div.className = 'notification-item';
      if (item.type === 'expiring-soon') div.classList.add('notification-item-warn');
      div.style.cursor = 'pointer';
      div.title = 'Click to edit ' + p.name;
      div.innerHTML = `
        <div class="notification-icon">${item.icon}</div>
        <div class="notification-content">
          ${item.html}
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Click to edit</div>
        </div>
      `;
      div.addEventListener('click', () => {
        const notifMod = document.getElementById('notifications-modal');
        if (notifMod) { notifMod.classList.add('hidden'); notifMod.setAttribute('aria-hidden', 'true'); }
        showPage('productsPage');
        openEditProductModal(p);
      });
      container.appendChild(div);
    });
  };

  if (allItems.length > 0) {
    if (badge) { badge.textContent = allItems.length; badge.style.display = 'flex'; }
    if (modalList) buildItems(modalList);
    if (modalEmpty) modalEmpty.style.display = 'none';
  } else {
    if (badge) badge.style.display = 'none';
    if (modalList) modalList.innerHTML = '';
    if (modalEmpty) modalEmpty.style.display = 'block';
  }
}

function openEditProductModal(product) {
  editingProductId = product.id;
  document.getElementById('new-product-name').value = product.name || '';
  const barcodeInput = document.getElementById('new-product-barcode');
  if (barcodeInput) barcodeInput.value = product.barcode || '';
  document.getElementById('new-product-unit').value = product.unit || 'pcs';
  // populate category select
  const catSel = document.getElementById('new-product-category');
  if (catSel) {
    catSel.innerHTML = '<option value="">No Category</option>';
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      if (c.name === product.category) opt.selected = true;
      catSel.appendChild(opt);
    });
    if (product.category && !categories.find(c => c.name === product.category)) {
      const opt = document.createElement('option');
      opt.value = product.category;
      opt.textContent = product.category;
      opt.selected = true;
      catSel.appendChild(opt);
    }
  }
  document.getElementById('new-product-price').value = Number(product.price || 0).toFixed(2);
  document.getElementById('new-product-capital').value = Number(product.capital || 0).toFixed(2);
  document.getElementById('new-product-profit').value = Number((product.price || 0) - (product.capital || 0)).toFixed(2);
  document.getElementById('new-product-stock').value = Number(product.stock || 0).toFixed(2);
  resetExpiryRows(product.expirationDates || []);
  document.querySelector('#add-product-modal .add-product-header h4').textContent = 'Edit Product';
  document.getElementById('add-product-save').textContent = 'Update Product';
  addProductModal.classList.remove('hidden');
  addProductModal.setAttribute('aria-hidden', 'false');
}

function setCategory(cat) {
  currentCategory = cat;

  document.querySelectorAll('#categories button').forEach(b => b.classList.toggle('active', b.innerText.trim() === cat));
  renderProducts();
}

window.setCategory = setCategory;

function setLendingCategory(cat) {
  currentLendingCategory = cat;

  document.querySelectorAll('#lending-categories button').forEach(b => b.classList.toggle('active', b.innerText.trim() === cat));
  renderLendingProducts();
}

window.setLendingCategory = setLendingCategory;

function renderLendingProducts() {
  const div = document.getElementById("lending-products");
  div.innerHTML = "";


  renderLendingCategoriesUI();

  let filtered = products;


  const q = cleanStr(searchState.lending);
  if (q) {

    filtered = filtered.filter(p => cleanStr(p.name).includes(q));
  }


  if (currentLendingCategory !== "All") {
    filtered = filtered.filter(p => p.category === currentLendingCategory);
  }

  if (filtered.length === 0) {
    div.innerHTML = '<div style="color:var(--muted);width:100%">No items found</div>';
    return;
  }

  const LOW_STOCK_THRESHOLD = 5;
  filtered.forEach((p) => {
    let btn = document.createElement("button");
    const stock = Number(p.stock || 0);
    const isOut = stock <= 0;
    const isLow = !isOut && stock <= LOW_STOCK_THRESHOLD;
    const stockDisplay = isOut
      ? `<span class="btn-stock btn-stock-out">Out of stock</span>`
      : isLow
        ? `<span class="btn-stock btn-stock-low">${Number(stock).toFixed(p.unit&&p.unit.toLowerCase()==='kg'?2:0)} ${p.unit}</span>`
        : `<span class="btn-stock btn-stock-ok">${Number(stock).toFixed(p.unit&&p.unit.toLowerCase()==='kg'?2:0)} ${p.unit}</span>`;
    btn.innerHTML = `
      <span class="btn-name">${p.name}</span>
      <div class="btn-bottom-row">
        <span class="btn-price">${formatCurrency(p.price)}</span>
        ${stockDisplay}
      </div>
    `;

    if (isOut) {
      btn.classList.add('btn-out-of-stock');
      btn.title = p.name + ' is out of stock';
    } else if (isLow) {
      btn.classList.add('btn-low-stock');
      btn.title = 'Low stock: ' + stock + ' ' + (p.unit || '') + ' remaining';
    }

    btn.onclick = () => {
      playSfx('click');
      addToLendingCart(p);
    };

    const categoryInfo = categories.find(c => c.name === p.category);
    if (!isOut && !isLow && categoryInfo && categoryInfo.color) {
      btn.style.background = categoryInfo.color;
    } else if (!isOut && !isLow) {
      const cat = (p.category || '').toLowerCase().trim();
      if (cat === 'vegetables') btn.classList.add('category-vegetables');
      else if (cat === 'frozen foods') btn.classList.add('category-frozen-foods');
      else if (cat === 'groceries') btn.classList.add('category-groceries');
    }

    div.appendChild(btn);
  });
}

function addToLendingCart(product) {
  if (!product) return;


  if (product.unit && product.unit.toLowerCase() === 'kg') {
    openLendingWeightModal(product);
    return;
  }


  let existing = lendingCart.find(item => item.name === product.name && item.unit === product.unit);

  if (existing) {
    existing.qty += 1;
    existing.total = Number((existing.qty * existing.price).toFixed(2));
  } else {
    lendingCart.push({
      name: product.name,
      price: Number(product.price),
      unit: product.unit,
      qty: 1,
      total: Number((1 * Number(product.price)).toFixed(2))
    });
  }

  playSfx('add');
  renderLendingCart();
}

function renderLendingCart() {
  const list = document.getElementById("lending-cart");
  const totalSpan = document.getElementById("lending-total");

  list.innerHTML = "";
  let total = 0;

  lendingCart.forEach((item, idx) => {
    let lineTotalNumber = 0;
    let lineText = '';

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      lineTotalNumber = Number(item.total);
      const displayWeight = Number(item.weight).toFixed(2);
      lineText = `${item.name} (${item.unit}) ${displayWeight}kg = ${formatCurrency(lineTotalNumber)}`;
    } else {
      lineTotalNumber = Number(item.price * item.qty);
      lineText = `${item.name} (${item.unit}) x${Number(item.qty).toFixed(2)} = ${formatCurrency(lineTotalNumber)}`;
    }

    total += lineTotalNumber;

    let li = document.createElement("li");

    const text = document.createElement('span');
    text.className = 'cart-item-text';
    text.innerText = lineText;


    const actions = document.createElement('div');

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const editBtn = document.createElement('button');
      editBtn.className = 'remove-btn';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => openLendingWeightModal({ name: item.name, price: item.price, unit: item.unit }, idx, item.weight);
      actions.appendChild(editBtn);
    } else {
      const minus = document.createElement('button');
      minus.className = 'remove-btn';
      minus.textContent = '-';
      minus.onclick = () => changeLendingQty(idx, -1);

      const plus = document.createElement('button');
      plus.className = 'checkout-btn';
      plus.style.marginLeft = '8px';
      plus.textContent = '+';
      plus.onclick = () => changeLendingQty(idx, 1);

      actions.appendChild(minus);
      actions.appendChild(plus);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.style.marginLeft = '8px';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => removeFromLendingCart(idx);

    actions.appendChild(removeBtn);

    li.appendChild(text);
    li.appendChild(actions);
    list.appendChild(li);
  });


  currentSubtotal = Number(total);
  totalSpan.innerText = formatCurrency(total);
}

function removeFromLendingCart(index) {
  if (index < 0 || index >= lendingCart.length) return;
  playSfx('delete');
  lendingCart.splice(index, 1);
  renderLendingCart();
}

function changeLendingQty(index, delta) {
  const item = lendingCart[index];
  if (!item) return;
  if (item.unit && item.unit.toLowerCase() === 'kg') return;

  item.qty = Math.max(1, item.qty + delta);
  item.total = Number((item.qty * item.price).toFixed(2));
  renderLendingCart();
}

function clearLendingCart() {
  lendingCart = [];
  renderLendingCart();
}


function openLendingWeightModal(product, editIndex = null, existingWeight = null) {
  modalProduct = product;
  modalEditIndex = (typeof editIndex === 'number') ? editIndex : null;
  isLendingModal = true;
  document.getElementById('lending-modal-product-name').innerText = product.name;
  document.getElementById('lending-modal-price').innerText = Number(product.price).toFixed(2);

  const w = document.getElementById('lending-modal-weight');
  const a = document.getElementById('lending-modal-amount');

  if (existingWeight != null) {
    w.value = Number(existingWeight).toFixed(2);
    a.value = Number((existingWeight * product.price).toFixed(2));
  } else {
    w.value = '';
    a.value = '';
  }

  document.getElementById('lending-weight-modal').classList.remove('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'false');
}


const clearLendingBtn = document.getElementById('clear-lending-cart');
if (clearLendingBtn) clearLendingBtn.onclick = clearLendingCart;


const lendBtn = document.getElementById('lend');
if (lendBtn) lendBtn.onclick = () => {
  if (lendingCart.length === 0) {
    alert('Lending cart is empty');
    return;
  }
  document.getElementById('borrower-name').value = '';
  document.getElementById('borrower-modal').classList.remove('hidden');
  document.getElementById('borrower-modal').setAttribute('aria-hidden', 'false');
};


const borrowerCancel = document.getElementById('borrower-cancel');
if (borrowerCancel) borrowerCancel.onclick = () => {
  document.getElementById('borrower-modal').classList.add('hidden');
  document.getElementById('borrower-modal').setAttribute('aria-hidden', 'true');
};

const borrowerConfirm = document.getElementById('borrower-confirm');
if (borrowerConfirm) borrowerConfirm.onclick = async () => {
  const borrowerName = document.getElementById('borrower-name').value.trim();
  if (!borrowerName) {
    alert('Please enter borrower name');
    return;
  }
  await saveLending(borrowerName);
};

async function saveLending(borrowerName) {
  const lendingDoc = {
    borrowerName: borrowerName,
    items: lendingCart.map(i => {
      const it = {
        name: i.name,
        unit: i.unit,
        price: i.price,
        total: i.total
      };
      if (i.unit && i.unit.toLowerCase() === 'kg') {
        it.weight = Number(i.weight);
      } else {
        it.qty = i.qty;
      }
      return it;
    }),
    total: lendingCart.reduce((s, i) => s + i.total, 0),
    timestamp: serverTimestamp(),
    returned: false
  };

  try {
    const lendingForSave = { ...lendingDoc, timestamp: new Date() };
    await safeWrite('add', 'lendings', lendingForSave);
    playSfx('success');
    lendingCart = [];
    renderLendingCart();
    document.getElementById('borrower-modal').classList.add('hidden');
    document.getElementById('borrower-modal').setAttribute('aria-hidden', 'true');
    alert('Lending recorded successfully!');
  } catch (err) {
    console.error('Failed to save lending', err);
    alert('Failed to save lending. Check console for details.');
  }
}

function renderProducts() {
  const div = document.getElementById("products");
  div.innerHTML = "";


  renderCategoriesUI();

  let filtered = products;


  const q = cleanStr(searchState.sales);
  if (q) {
    filtered = filtered.filter(p => cleanStr(p.name).includes(q) || cleanStr(p.barcode).includes(q));
  }


  if (currentCategory !== "All") {
    filtered = filtered.filter(p => p.category === currentCategory);
  }

  if (filtered.length === 0) {
    div.innerHTML = '<div style="color:var(--muted);width:100%">No products found</div>';
    return;
  }

  const LOW_STOCK_THRESHOLD = 5;
  filtered.forEach((p) => {
    let btn = document.createElement("button");
    const stock = Number(p.stock || 0);
    const isOut = stock <= 0;
    const isLow = !isOut && stock <= LOW_STOCK_THRESHOLD;
    const stockDisplay = isOut
      ? `<span class="btn-stock btn-stock-out">Out of stock</span>`
      : isLow
        ? `<span class="btn-stock btn-stock-low">${Number(stock).toFixed(p.unit&&p.unit.toLowerCase()==='kg'?2:0)} ${p.unit}</span>`
        : `<span class="btn-stock btn-stock-ok">${Number(stock).toFixed(p.unit&&p.unit.toLowerCase()==='kg'?2:0)} ${p.unit}</span>`;
    btn.innerHTML = `
      <span class="btn-name">${p.name}</span>
      <div class="btn-bottom-row">
        <span class="btn-price">${formatCurrency(p.price)}</span>
        ${stockDisplay}
      </div>
    `;

    if (isOut) {
      btn.classList.add('btn-out-of-stock');
      btn.title = p.name + ' is out of stock';
    } else if (isLow) {
      btn.classList.add('btn-low-stock');
      btn.title = 'Low stock: ' + stock + ' ' + (p.unit || '') + ' remaining';
    }

    btn.onclick = () => {
      playSfx('click');
      addToCart(p);
    };


    const categoryInfo = categories.find(c => c.name === p.category);
    if (!isOut && !isLow && categoryInfo && categoryInfo.color) {
      btn.style.background = categoryInfo.color;
    } else if (!isOut && !isLow) {

      const cat = (p.category || '').toLowerCase().trim();
      if (cat === 'vegetables') btn.classList.add('category-vegetables');
      else if (cat === 'frozen foods') btn.classList.add('category-frozen-foods');
      else if (cat === 'groceries') btn.classList.add('category-groceries');
    }

    div.appendChild(btn);
  });
}

function addToCartByName(name) {
  const product = products.find(p => p.name === name);
  if (product) addToCart(product);
}

let _addToCartBusy = false;
function addToCart(product) {
  if (!product) return;
  if (_addToCartBusy) return;
  _addToCartBusy = true;
  setTimeout(() => { _addToCartBusy = false; }, 300);


  if (product.unit && product.unit.toLowerCase() === 'kg') {
    openWeightModal(product);
    _addToCartBusy = false;
    return;
  }


  const normalUnit = (product.unit || '').toLowerCase();
  let existing = cart.find(item => item.name === product.name && (item.unit || '').toLowerCase() === normalUnit);

  if (existing) {
    existing.qty += 1;
    existing.total = Number((existing.qty * existing.price).toFixed(2));
  } else {
    cart.push({
      name: product.name,
      price: Number(product.price),
      unit: product.unit,
      qty: 1,
      total: Number((1 * Number(product.price)).toFixed(2))
    });
  }

  playSfx('add');
  renderCart();
}


function renderCart() {
  const list = document.getElementById("cart");
  const totalSpan = document.getElementById("total");
  const cashInput = document.getElementById("cash");
  const changeSpan = document.getElementById("change");

  list.innerHTML = "";
  let total = 0;

  cart.forEach((item, idx) => {
    let lineTotalNumber = 0;
    let lineText = '';

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      lineTotalNumber = Number(item.total);
      const displayWeight = Number(item.weight).toFixed(2);
      lineText = `${item.name} (${item.unit}) ${displayWeight}kg = ${formatCurrency(lineTotalNumber)}`;
    } else {
      lineTotalNumber = Number(item.price * item.qty);
      lineText = `${item.name} (${item.unit}) x${Number(item.qty).toFixed(2)} = ${formatCurrency(lineTotalNumber)}`;
    }

    total += lineTotalNumber;

    let li = document.createElement("li");

    const text = document.createElement('span');
    text.className = 'cart-item-text';
    text.innerText = lineText;


    const actions = document.createElement('div');

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const editBtn = document.createElement('button');
      editBtn.className = 'remove-btn';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => openWeightModal({ name: item.name, price: item.price, unit: item.unit }, idx, item.weight);
      actions.appendChild(editBtn);
    } else {
      const minus = document.createElement('button');
      minus.className = 'remove-btn';
      minus.textContent = '-';
      minus.onclick = () => changeQty(idx, -1);

      const plus = document.createElement('button');
      plus.className = 'checkout-btn';
      plus.style.marginLeft = '8px';
      plus.textContent = '+';
      plus.onclick = () => changeQty(idx, 1);

      actions.appendChild(minus);
      actions.appendChild(plus);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.style.marginLeft = '8px';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => removeFromCart(idx);

    actions.appendChild(removeBtn);

    li.appendChild(text);
    li.appendChild(actions);
    list.appendChild(li);
  });


  currentSubtotal = Number(total);
  totalSpan.innerText = formatCurrency(total);


  if (cashInput) cashInput.oninput = () => updateTotals();


  const discountInput = document.getElementById('discount');
  if (discountInput) discountInput.oninput = () => updateTotals();


  updateTotals();
}

function updateTotals() {
  const subtotal = Number(currentSubtotal || 0);
  const discount = Number(document.getElementById('discount')?.value) || 0;
  const total = Number(Math.max(0, (subtotal - discount)).toFixed(2));
  const cash = Number(document.getElementById('cash')?.value) || 0;

  const subtotalEl = document.getElementById('subtotal');
  const totalEl = document.getElementById('total');
  const changeEl = document.getElementById('change');
  const receiptDiscountEl = document.getElementById('receipt-discount');

  if (subtotalEl) subtotalEl.innerText = formatCurrency(subtotal);
  if (totalEl) totalEl.innerText = formatCurrency(total);
  if (changeEl) changeEl.innerText = formatCurrency(cash - total);
  if (receiptDiscountEl) receiptDiscountEl.innerText = formatCurrency(discount);
}

function removeFromCart(index) {
  if (index < 0 || index >= cart.length) return;
  playSfx('delete');
  cart.splice(index, 1);
  renderCart();
  updateTotals();
}

function clearCart() {
  playSfx('delete');
  cart = [];
  renderCart();
}

function changeQty(index, delta) {
  const item = cart[index];
  if (!item) return;
  if (item.unit && item.unit.toLowerCase() === 'kg') return;

  item.qty = Math.max(1, item.qty + delta);
  item.total = Number((item.qty * item.price).toFixed(2));
  renderCart();
}


const checkoutBtnEl = document.getElementById("checkout");
if (checkoutBtnEl) checkoutBtnEl.onclick = () => {

  if (!canCheckout()) {
    alert('You must start a shift before checkout.');
    return;
  }


  updateTotals();
  const discount = Number(document.getElementById('discount')?.value) || 0;
  const total = Number(Math.max(0, (Number(currentSubtotal || 0) - discount)).toFixed(2));
  const cash = Number(document.getElementById('cash').value) || 0;
  if (cash < total) {
    showErrorModal("Cannot proceed to checkout. Cash Payment isn't enough");
    return;
  }
  openReceiptModal();
}


function showErrorModal(msg) {
  const modal = document.getElementById('error-modal');
  const msgEl = document.getElementById('error-modal-message');
  if (msgEl) msgEl.innerText = msg;
  if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); }
}

function closeErrorModal() {
  const modal = document.getElementById('error-modal');
  if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
}


const errorOkBtn = document.getElementById('error-ok');
if (errorOkBtn) errorOkBtn.onclick = () => {
  closeErrorModal();
  const cashInput = document.getElementById('cash');
  if (cashInput) cashInput.focus();
};


function isPageAllowedForRole(id) {
  if (!currentUserRole) return false;

  if (currentUserRole === 'admin') return true;

  if (currentUserRole === 'cashier') return id === 'salesPage' || id === 'receiptsPage' || id === 'cashierPage' || id === 'eloadingPage' || id === 'icePage';

  if (id === 'financePage' || id === 'remitsPage' || id === 'profitsPage') return currentUserRole === 'admin';
  return false;
}

function showPage(id) {

  if (!isPageAllowedForRole(id)) {
    alert('You are not authorized to view this page');
    id = 'salesPage';
  }


  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('page-active');
    p.classList.add('page-hidden');
    p.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('page-hidden');
    el.classList.add('page-active');
    el.style.display = 'block';
  }


  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.innerText.trim().toLowerCase() === id.replace('Page', '').toLowerCase());
  if (navBtn) navBtn.classList.add('active');

  // Sidebar active state
  document.querySelectorAll('.sidebar-link').forEach(b => b.classList.remove('active'));
  const sidebarBtn = document.querySelector('.sidebar-link[data-page="' + id + '"]');
  if (sidebarBtn) sidebarBtn.classList.add('active');

  // Topbar page name
  const topbarPageName = document.getElementById('topbar-page-name');
  if (topbarPageName) {
    const pageLabels = { salesPage: 'Sales', receiptsPage: 'Receipts', cashierPage: 'Cashier', productsPage: 'Stocks', lendingPage: 'Lending', financePage: 'Finance', remitsPage: 'Remits', profitsPage: 'Profits', adminPage: 'Admin', eloadingPage: 'eLoading', icePage: 'Ice Sales' };
    topbarPageName.textContent = pageLabels[id] || id.replace('Page', '');
  }

  // Close sidebar on mobile after navigation
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (window.innerWidth <= 768 && sidebar) {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  }


  document.getElementById('nav-links').classList.remove('open');
  const hm = document.getElementById('hamburger-menu'); if (hm) hm.classList.remove('open');


  const pageTitle = document.getElementById('page-title');
  if (pageTitle) {
    pageTitle.style.display = (id === 'salesPage') ? 'block' : 'none';
  }


  if (id === 'salesPage') loadSalesSummary();
  if (id === 'productsPage') renderProductsEditor();
  if (id === 'cashierPage') {
    try { if (typeof loadMyShifts === 'function') loadMyShifts(); } catch (err) { console.error('loadMyShifts failed', err); }
  }
  if (id === 'adminPage') {
    try { if (typeof loadShiftsDropdown === 'function') loadShiftsDropdown(); } catch (err) { console.error('loadShiftsDropdown failed', err); }
    try { if (typeof loadCashiersList === 'function') loadCashiersList(); } catch (err) { console.error('loadCashiersList failed', err); }
    try { if (typeof loadEmployees === 'function') loadEmployees(); } catch (err) { console.error('loadEmployees failed', err); }
  }
  if (id === 'remitsPage') loadRemits();
  if (id === 'profitsPage') loadProfits();
  if (id === 'financePage') loadFinancePage();
  if (id === 'receiptsPage') {
    loadCashiersDropdown();
    loadSalesHistory();
  }
  if (id === 'lendingPage') {
    setLendingCategory('All');
    loadBorrowersList();
  }
  if (id === 'eloadingPage') loadEloadingPage();
  if (id === 'icePage') loadIcePage();
}


window.closeAddProductModal = () => {
  document.getElementById('add-product-modal').classList.add('hidden');
  document.getElementById('add-product-modal').setAttribute('aria-hidden', 'true');
};
window.closeAddEmployeeModal = () => {
  document.getElementById('add-employee-modal').classList.add('hidden');
  document.getElementById('add-employee-modal').setAttribute('aria-hidden', 'true');
};
window.closeLendingDetailsModal = () => {
  document.getElementById('lending-details-modal').classList.add('hidden');
  document.getElementById('lending-details-modal').setAttribute('aria-hidden', 'true');
};

const addProductClose = document.getElementById('add-product-close');
if (addProductClose) addProductClose.onclick = window.closeAddProductModal;
const addEmployeeClose = document.getElementById('add-employee-close');
if (addEmployeeClose) addEmployeeClose.onclick = window.closeAddEmployeeModal;
const receiptClose = document.getElementById('receipt-close');
if (receiptClose) receiptClose.onclick = closeReceiptModal;
const lendingDetailsClose = document.getElementById('lending-details-close');
if (lendingDetailsClose) lendingDetailsClose.onclick = window.closeLendingDetailsModal;


window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeReceiptModal();
    window.closeAddProductModal();
    window.closeAddEmployeeModal();
    window.closeLendingDetailsModal();
    closeErrorModal();
  }
});

window.showPage = showPage;


const hamburger = document.getElementById('hamburger');
if (hamburger) hamburger.onclick = () => { const hm = document.getElementById('hamburger-menu'); if (hm) hm.classList.toggle('open'); };
// Sidebar toggle (desktop collapse + mobile slide)
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarEl = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      // Mobile: slide in/out
      if (sidebarEl) sidebarEl.classList.toggle('open');
      if (sidebarOverlay) sidebarOverlay.classList.toggle('visible');
    } else {
      // Desktop: collapse/expand sidebar + shift layout
      const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
      document.body.style.paddingLeft = isCollapsed ? '0' : '240px';
    }
  });
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', () => {
    if (sidebarEl) sidebarEl.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
  });
}
// Re-evaluate layout on resize
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    if (sidebarEl) sidebarEl.classList.remove('open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('visible');
    const isCollapsed = document.body.classList.contains('sidebar-collapsed');
    document.body.style.paddingLeft = isCollapsed ? '0' : '240px';
  } else {
    if (!document.body.classList.contains('sidebar-collapsed')) {
      document.body.style.paddingLeft = '0';
    }
  }
});


const notifBellBtn = document.getElementById('notif-bell-btn');
const notifModal = document.getElementById('notifications-modal');
const notifModalClose = document.getElementById('notif-modal-close');
if (notifBellBtn && notifModal) {
  notifBellBtn.addEventListener('click', () => {
    notifModal.classList.remove('hidden');
    notifModal.setAttribute('aria-hidden', 'false');
  });
}
if (notifModalClose && notifModal) {
  notifModalClose.addEventListener('click', () => {
    notifModal.classList.add('hidden');
    notifModal.setAttribute('aria-hidden', 'true');
  });
}
if (notifModal) {
  notifModal.addEventListener('click', (e) => {
    if (e.target === notifModal) {
      notifModal.classList.add('hidden');
      notifModal.setAttribute('aria-hidden', 'true');
    }
  });
}


function openReceiptModal(saleObj = null) {

  const modal = document.getElementById('receipt-modal');
  const itemsList = document.getElementById('receipt-items');
  const datetime = document.getElementById('receipt-datetime');
  const cashierEl = document.getElementById('receipt-cashier');
  const subtotalEl = document.getElementById('receipt-subtotal');
  const discountEl = document.getElementById('receipt-discount');
  const totalEl = document.getElementById('receipt-total');
  const cashInput = document.getElementById('receipt-cash');
  const changeEl = document.getElementById('receipt-change');
  const receiptSaveBtn = document.getElementById('receipt-save');

  itemsList.innerHTML = '';
  let subtotal = 0;

  const itemsSource = saleObj ? saleObj.items : cart;

  itemsSource.forEach(item => {
    let lineTotal = 0;
    let li = document.createElement('li');
    li.className = 'receipt-item-row';

    const mkSpan = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };

    if (item.unit && item.unit.toLowerCase() === 'kg') {
      const weight = item.weight || 0;
      lineTotal = Number(item.lineTotal ?? item.total ?? 0);
      li.appendChild(mkSpan('rcol-name', item.name));
      li.appendChild(mkSpan('rcol-qty', Number(weight).toFixed(2) + 'kg'));
      li.appendChild(mkSpan('rcol-price', formatCurrency(item.price) + '/kg'));
      li.appendChild(mkSpan('rcol-amt', formatCurrency(lineTotal)));
    } else {
      const qty = item.qty || 0;
      lineTotal = Number(item.lineTotal ?? (item.price * qty) ?? 0);
      li.appendChild(mkSpan('rcol-name', item.name));
      li.appendChild(mkSpan('rcol-qty', 'x' + Number(qty)));
      li.appendChild(mkSpan('rcol-price', formatCurrency(item.price)));
      li.appendChild(mkSpan('rcol-amt', formatCurrency(lineTotal)));
    }

    subtotal += lineTotal;
    itemsList.appendChild(li);
  });

  const discountVal = saleObj ? Number(saleObj.discount || 0) : Number(document.getElementById('discount')?.value || 0);
  const totalAfter = Number((subtotal - discountVal).toFixed(2));

  subtotalEl.innerText = formatCurrency(subtotal);
  if (discountEl) discountEl.innerText = formatCurrency(discountVal);
  totalEl.innerText = formatCurrency(totalAfter);

  const now = saleObj && saleObj.timestamp ? (saleObj.timestamp.toDate ? saleObj.timestamp.toDate() : new Date(saleObj.timestamp)) : new Date();
  datetime.innerText = now.toLocaleString();

  if (saleObj) {

    const cash = Number(saleObj.cash) || 0;
    const change = Number(saleObj.change) || (cash - totalAfter);
    cashInput.value = cash ? cash.toFixed(2) : '';
    cashInput.disabled = true;
    changeEl.innerText = formatCurrency(change);
    if (receiptSaveBtn) receiptSaveBtn.style.display = 'none';
    if (cashierEl) cashierEl.innerText = 'Cashier: ' + (saleObj.cashier || 'Unknown');
  } else {

    const mainCash = Number(document.getElementById('cash').value) || 0;
    cashInput.value = mainCash ? mainCash.toFixed(2) : '';
    cashInput.disabled = false;
    if (receiptSaveBtn) receiptSaveBtn.style.display = '';


    cashInput.oninput = () => {
      const cash = Number(cashInput.value) || 0;
      const change = cash - totalAfter;
      changeEl.innerText = formatCurrency(change);
    };

    const initialCash = Number(cashInput.value) || 0;
    changeEl.innerText = formatCurrency(initialCash - totalAfter);
    if (cashierEl) cashierEl.innerText = 'Cashier: ' + (currentEmployeeName || currentUsername || 'Unknown');
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeReceiptModal() {
  const modal = document.getElementById('receipt-modal');

  const cashInput = document.getElementById('receipt-cash');
  const receiptSaveBtn = document.getElementById('receipt-save');
  if (cashInput) { cashInput.disabled = false; cashInput.value = ''; }
  if (receiptSaveBtn) receiptSaveBtn.style.display = '';


  const receiptDiscount = document.getElementById('receipt-discount');
  if (receiptDiscount) receiptDiscount.innerText = formatCurrency(0);

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}




const receiptSave = document.getElementById('receipt-save');
let _receiptSaving = false;
if (receiptSave) receiptSave.onclick = async () => {
  if (_receiptSaving) return;
  _receiptSaving = true;
  receiptSave.disabled = true;
  receiptSave.textContent = 'Saving...';

  const cash = Number(document.getElementById('receipt-cash').value) || 0;

  const itemsForSave = cart.map(i => {
    const it = {
      name: i.name,
      unit: i.unit,
      price: Number(i.price)
    };

    if (i.unit && i.unit.toLowerCase() === 'kg') {
      it.weight = Number(i.weight);
      it.lineTotal = Number(i.total);
    } else {
      it.qty = i.qty;
      it.lineTotal = Number((i.price * i.qty).toFixed(2));
    }

    return it;
  });


  let subtotal = itemsForSave.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);
  subtotal = Number(subtotal.toFixed(2));


  const discountVal = Number(document.getElementById('discount')?.value || 0);
  if (discountVal < 0) {
    showErrorModal('Invalid discount amount');
    return;
  }
  if (discountVal > subtotal) {
    showErrorModal('Discount cannot exceed subtotal');
    return;
  }

  const total = Number((subtotal - discountVal).toFixed(2));
  const change = Number((cash - total).toFixed(2));


  if (currentUserRole === 'cashier') {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open' || (String(currentShift.cashierName || '').trim() !== String(currentEmployeeName || '').trim())) {
      console.warn('Receipt save blocked - no active shift for current cashier', { currentShift, currentEmployeeName });
      return alert('You must start a shift before checkout.');
    }
  } else {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
      console.warn('Receipt save blocked - no active shift found for non-cashier user', { currentShift });
      return alert('No open shift. Please start a shift before saving sales.');
    }
  }


  const receiptCash = Number(document.getElementById('receipt-cash').value) || 0;
  if (receiptCash < total) {
    showErrorModal("Cannot proceed to checkout. Cash Payment isn't enough");
    return;
  }

  const saleDoc = {
    timestamp: new Date(),
    shiftId: currentShift.id,
    items: itemsForSave,
    subtotal: Number(subtotal.toFixed(2)),
    discount: Number(discountVal.toFixed(2)),
    total: Number(total.toFixed(2)),
    cash: Number(cash.toFixed(2)),
    change: Number(change.toFixed(2)),
    cashier: currentEmployeeName || currentUsername || 'Unknown'
  };

  try {
    await safeWrite('add', 'sales', saleDoc);

    try {
      const newTotal = Number(((Number(currentShift.totalIncome || currentShift.totalSales || 0) + saleDoc.total)).toFixed(2));
      await safeWrite('update', 'shifts', { totalIncome: newTotal }, currentShift.id);
      currentShift.totalIncome = newTotal;
    } catch (e) { console.error('Failed to update shift total', e); }


    for (const item of cart) {
      const product = products.find(p => p.name === item.name && p.unit === item.unit);
      if (product) {
        let deduct = 0;
        if (item.unit && item.unit.toLowerCase() === 'kg') {
          deduct = Number(item.weight || 0);
        } else {
          deduct = Number(item.qty || 0);
        }
        const newStock = Math.max(0, Number(product.stock || 0) - deduct);
        try {
          await safeWrite('update', 'products', { stock: newStock }, product.id);
          product.stock = newStock;
        } catch (e) {
          console.error('Failed to update stock for', product.name, e);
        }
      }
    }


    playSfx('chaching');
    cart = [];
    renderCart();
    closeReceiptModal();
    _receiptSaving = false;
    receiptSave.disabled = false;
    receiptSave.textContent = 'Add to Sales';

    const discountInput = document.getElementById('discount'); if (discountInput) discountInput.value = '';
    const cashInput = document.getElementById('cash'); if (cashInput) cashInput.value = '';
    alert('Sale recorded successfully!');

    loadSalesSummary();
    loadSalesHistory();
    updateShiftUI();

    loadProducts();
  } catch (err) {
    console.error('Save failed', err);
    alert('Failed to save sale. Check console for details.');
    _receiptSaving = false;
    receiptSave.disabled = false;
    receiptSave.textContent = 'Add to Sales';
  }
};


let modalProduct = null;
let modalEditIndex = null;
let isLendingModal = false;


const lendingModalWeightInput = document.getElementById('lending-modal-weight');
const lendingModalAmountInput = document.getElementById('lending-modal-amount');

if (lendingModalWeightInput && lendingModalAmountInput) {
  lendingModalWeightInput.oninput = () => {
    const w = Number(lendingModalWeightInput.value);
    if (!modalProduct) return;
    if (!isNaN(w) && w > 0) {
      lendingModalAmountInput.value = Number((w * modalProduct.price).toFixed(2));
    } else {
      lendingModalAmountInput.value = '';
    }
  };

  lendingModalAmountInput.oninput = () => {
    const a = Number(lendingModalAmountInput.value);
    if (!modalProduct) return;
    if (!isNaN(a) && a > 0) {
      lendingModalWeightInput.value = Number((a / modalProduct.price).toFixed(2));
    } else {
      lendingModalWeightInput.value = '';
    }
  };
}


async function loadSalesSummary() {
  const itemsSummary = {};
  let totalIncome = 0;


  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    document.getElementById('items-sold-tbody').innerHTML = '';
    document.getElementById('total-income').innerText = formatCurrency(0);
    return;
  }

  const q = query(collection(db, 'sales'), where('shiftId', '==', currentShift.id));
  const qSnap = await getDocs(q);
  qSnap.forEach(docSnap => {
    const s = docSnap.data();
    totalIncome += Number(s.total || 0);
    (s.items || []).forEach(it => {
      const key = `${it.name}||${it.unit}`;
      if (!itemsSummary[key]) itemsSummary[key] = { name: it.name, unit: it.unit, weight: 0, qty: 0 };
      if (it.unit && it.unit.toLowerCase() === 'kg') {
        itemsSummary[key].weight += Number(it.weight || 0);
      } else {
        itemsSummary[key].qty += Number(it.qty || 0);
      }
    });
  });


  if (currentShift && Number(currentShift.totalIncome || 0) !== Number(totalIncome.toFixed(2))) {
    currentShift.totalIncome = Number(totalIncome.toFixed(2));
  }

  const tbody = document.getElementById('items-sold-tbody');
  tbody.innerHTML = '';
  Object.values(itemsSummary).forEach(entry => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const unitTd = document.createElement('td');
    const soldTd = document.createElement('td');

    nameTd.innerText = entry.name;
    unitTd.innerText = entry.unit;
    if (entry.unit && entry.unit.toLowerCase() === 'kg') {
      soldTd.innerText = `${Number(entry.weight).toFixed(2)} Kg`;
    } else {
      soldTd.innerText = `${Number(Number(entry.qty).toFixed(2))} pcs`;
    }

    tr.appendChild(nameTd);
    tr.appendChild(unitTd);
    tr.appendChild(soldTd);
    tbody.appendChild(tr);
  });

  document.getElementById('total-income').innerText = formatCurrency(totalIncome);
}


async function loadCashiersDropdown() {
  const sel = document.getElementById('cashier-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Cashiers</option>';

  try {
    const q = query(collection(db, 'shifts'), orderBy('cashierName'));
    const qSnap = await getDocs(q);
    const names = new Set();
    qSnap.forEach(snap => {
      const d = snap.data();
      if (d.cashierName) names.add(d.cashierName);
    });

    names.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.innerText = name;
      sel.appendChild(opt);
    });

    if (historyFilters.cashier) sel.value = historyFilters.cashier;
  } catch (err) {
    console.error('Failed to load cashiers dropdown', err);
  }
}

async function loadShiftsDropdown() {
  const sel = document.getElementById('shift-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Shifts</option>';

  try {

    const q = query(collection(db, 'shifts'), orderBy('startTime', 'desc'), limit(50));
    const qSnap = await getDocs(q);
    qSnap.forEach(snap => {
      const d = snap.data();
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const opt = document.createElement('option');
      opt.value = snap.id;
      opt.innerText = `${d.cashierName || 'No Name'} - ${start}`;
      sel.appendChild(opt);
    });
    if (historyFilters.shiftId) sel.value = historyFilters.shiftId;
  } catch (err) {
    console.error('Failed to load shifts dropdown', err);
  }
}

async function loadProfits() {
  const container = document.getElementById('profits-list');
  const profitEl = document.getElementById('weekly-profit');
  if (!container || !profitEl) return;
  container.innerHTML = 'Loading profits...';

  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalProfit = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      let saleProfit = 0;

      (s.items || []).forEach(it => {
        const product = products.find(p => p.name === it.name && p.unit === it.unit);
        if (product && product.profit != null) {
          let quantity = (it.unit && it.unit.toLowerCase() === 'kg') ? Number(it.weight || 0) : Number(it.qty || 0);
          saleProfit += Number(product.profit) * quantity;
        }
      });

      totalProfit += saleProfit;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += saleProfit;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales this week';
    profitEl.innerText = formatCurrency(totalProfit);
  } catch (err) {
    console.error('Failed to load profits', err);
    container.innerText = 'Failed to load profits';
    profitEl.innerText = 'PHP 0.00';
  }
}

const cashierFilterEl = document.getElementById('cashier-filter');
if (cashierFilterEl) {
  cashierFilterEl.onchange = () => {
    historyFilters.cashier = cashierFilterEl.value;
    loadSalesHistory();
  };
}


async function loadCashiersList() {
  const container = document.getElementById('admin-cashier-list');
  if (!container) return;
  container.innerHTML = '';
  try {
    const q = query(collection(db, 'shifts'), orderBy('startTime', 'desc'));
    const qSnap = await getDocs(q);
    const seen = new Set();
    if (qSnap.empty) { container.innerText = 'No shifts recorded'; return; }
    qSnap.forEach(snap => {
      const d = snap.data() || {};
      const name = (d.cashierName || d.openedBy || '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        const btn = document.createElement('button');
        btn.className = 'checkout-btn';
        btn.innerHTML = `<span class="btn-text">${name}</span>`;
        btn.onclick = () => loadCashierShifts(name);
        container.appendChild(btn);
      }
    });
  } catch (err) { console.error('Failed to load cashiers list', err); container.innerText = 'Failed to load cashiers'; }
}

async function loadCashierShifts(name) {
  const container = document.getElementById('admin-cashier-shifts');
  if (!container) return;
  container.innerHTML = '';
  try {
    if (!name || typeof name !== 'string' || !name.trim()) {
      container.innerText = 'Invalid cashier name';
      console.warn('loadCashierShifts called with invalid name:', name);
      return;
    }
    console.log('loadCashierShifts: filter cashierName==', name);

    const q = query(collection(db, 'shifts'), where('cashierName', '==', name));
    console.log('Shift query object (no orderBy - sorting client-side):', q);
    let qSnap;
    try {
      qSnap = await getDocs(q);
    } catch (innerErr) {
      console.error('Error fetching shifts for', name, innerErr);
      container.innerText = 'Failed to load shifts: ' + (innerErr && innerErr.message ? innerErr.message : String(innerErr));
      return;
    }
    if (qSnap.empty) { container.innerText = 'No shifts recorded yet'; return; }


    const docs = qSnap.docs.map(snap => ({ id: snap.id, data: snap.data() || {} }));
    docs.sort((a, b) => {
      const ta = a.data.startTime && a.data.startTime.toDate ? a.data.startTime.toDate() : (a.data.startTime || new Date(0));
      const tb = b.data.startTime && b.data.startTime.toDate ? b.data.startTime.toDate() : (b.data.startTime || new Date(0));
      return tb - ta;
    });

    docs.forEach(item => {
      const d = item.data || {};
      const div = document.createElement('div');
      div.className = 'card';
      div.style.display = 'flex'; div.style.alignItems = 'center'; div.style.gap = '10px';
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const end = d.endTime && d.endTime.toDate ? d.endTime.toDate().toLocaleString() : (d.endTime ? d.endTime.toString() : '-');
      const infoDiv = document.createElement('div');
      infoDiv.style.flex = '1';
      infoDiv.innerHTML = `<strong>${name}</strong> - ${d.status || 'unknown'} - Started: ${start} - End: ${end} - Total: ${formatCurrency(Number(d.totalIncome || d.totalSales || 0))}`;
      div.appendChild(infoDiv);
      if (currentUserRole === 'admin') {
        const delBtn = document.createElement('button');
        delBtn.className = 'remove-btn';
        delBtn.style.flexShrink = '0';
        delBtn.textContent = 'Delete Shift';
        delBtn.onclick = async () => {
          if (!confirm('Delete this shift record for ' + name + '? This cannot be undone.')) return;
          try {
            await safeWrite('delete', 'shifts', null, item.id);
            div.remove();
          } catch (err) { console.error('Failed to delete shift', err); alert('Failed to delete shift. See console.'); }
        };
        div.appendChild(delBtn);
      }
      container.appendChild(div);
    });
  } catch (err) { console.error('Failed to load cashier shifts for', name, err); container.innerText = 'Failed to load shifts: ' + (err && err.message ? err.message : String(err)); }
}


async function loadMyShifts() {
  const container = document.getElementById('cashier-my-shifts');
  if (!container) return;
  container.innerHTML = '';

  const name = (currentEmployeeName || '').trim();
  if (!name) {
    container.innerText = 'No employee name assigned to your account';
    return;
  }

  try {
    console.log('loadMyShifts: filter cashierName==', name);
    if (!name || typeof name !== 'string' || !name.trim()) {
      container.innerText = 'No employee name assigned to your account';
      console.warn('loadMyShifts: missing employee name for current user', { currentUserRole, currentUsername, currentEmployeeName });
      return;
    }

    const q = query(collection(db, 'shifts'), where('cashierName', '==', name));
    console.log('My Shift query object (no orderBy - sorting client-side):', q);
    let qSnap;
    try {
      qSnap = await getDocs(q);
    } catch (innerErr) {
      console.error('Error fetching my shifts for', name, innerErr);
      container.innerText = 'Failed to load shifts: ' + (innerErr && innerErr.message ? innerErr.message : String(innerErr));
      return;
    }
    if (qSnap.empty) { container.innerText = 'No shifts recorded yet'; return; }


    const docs = qSnap.docs.map(snap => ({ id: snap.id, data: snap.data() || {} }));
    docs.sort((a, b) => {
      const ta = a.data.startTime && a.data.startTime.toDate ? a.data.startTime.toDate() : (a.data.startTime || new Date(0));
      const tb = b.data.startTime && b.data.startTime.toDate ? b.data.startTime.toDate() : (b.data.startTime || new Date(0));
      return tb - ta;
    });

    docs.forEach(item => {
      const d = item.data || {};
      const div = document.createElement('div');
      div.className = 'card';
      div.style.display = 'flex'; div.style.alignItems = 'center'; div.style.gap = '10px';
      const start = d.startTime && d.startTime.toDate ? d.startTime.toDate().toLocaleString() : (d.startTime || '');
      const end = d.endTime && d.endTime.toDate ? d.endTime.toDate().toLocaleString() : (d.endTime ? d.endTime.toString() : '-');
      const infoDiv = document.createElement('div');
      infoDiv.style.flex = '1';
      infoDiv.innerHTML = `<strong>${name}</strong> - ${d.status || 'unknown'} - Started: ${start} - End: ${end} - Total: ${formatCurrency(Number(d.totalIncome || d.totalSales || 0))}`;
      div.appendChild(infoDiv);
      if (currentUserRole === 'admin') {
        const delBtn = document.createElement('button');
        delBtn.className = 'remove-btn';
        delBtn.style.flexShrink = '0';
        delBtn.textContent = 'Delete Shift';
        delBtn.onclick = async () => {
          if (!confirm('Delete this shift record for ' + name + '? This cannot be undone.')) return;
          try {
            await safeWrite('delete', 'shifts', null, item.id);
            div.remove();
          } catch (err) { console.error('Failed to delete shift', err); alert('Failed to delete shift. See console.'); }
        };
        div.appendChild(delBtn);
      }
      container.appendChild(div);
    });
  } catch (err) { console.error('Failed to load my shifts for', name, err); container.innerText = 'Failed to load shifts: ' + (err && err.message ? err.message : String(err)); }

}


async function loadRemits() {
  const container = document.getElementById('remits-list');
  const capitalEl = document.getElementById('weekly-capital');
  if (!container || !capitalEl) return;
  container.innerHTML = 'Loading remits...';

  try {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalCapital = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      const amount = Number(s.total || 0);
      totalCapital += amount;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += amount;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales this week';
    capitalEl.innerText = formatCurrency(totalCapital);
  } catch (err) {
    console.error('Failed to load remits', err);
    container.innerText = 'Failed to load remits';
    capitalEl.innerText = 'PHP 0.00';
  }
}



let financeRange = { start: null, end: null, preset: 'weekly' };

function updateFinanceRange(preset) {
  const now = new Date();
  let start = new Date(now);
  start.setHours(0, 0, 0, 0);
  let end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (preset === 'daily') {

  } else if (preset === 'weekly') {
    start.setDate(now.getDate() - (now.getDay() || 7) + 1);
    end.setDate(start.getDate() + 6);
  } else if (preset === 'monthly') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (preset === 'annual') {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  }

  financeRange = { start, end, preset };
  renderFinanceRange();
  loadFinancePage();
}

function renderFinanceRange() {
  const display = document.getElementById('fin-range-display');
  if (!display || !financeRange.start || !financeRange.end) return;
  const s = financeRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const e = financeRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  display.innerText = `${s} - ${e}`;


  const startInput = document.getElementById('fin-start-date');
  const endInput = document.getElementById('fin-end-date');
  if (startInput) startInput.value = financeRange.start.toISOString().split('T')[0];
  if (endInput) endInput.value = financeRange.end.toISOString().split('T')[0];
}


function initFinanceListeners() {
  document.querySelectorAll('.fin-preset').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.fin-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateFinanceRange(btn.dataset.preset);
    };
  });

  const finStartInput = document.getElementById('fin-start-date');
  const finEndInput = document.getElementById('fin-end-date');

  const onFinanceDateChange = () => {
    const sStr = finStartInput.value;
    const eStr = finEndInput.value;
    if (!sStr || !eStr) return;

    const start = new Date(sStr + 'T00:00:00');
    const end = new Date(eStr + 'T23:59:59.999');

    const warning = document.getElementById('fin-date-warning');
    if (end < start) {
      if (warning) warning.style.display = 'block';
      return;
    }
    if (warning) warning.style.display = 'none';

    financeRange = { start, end, preset: 'custom' };
    document.querySelectorAll('.fin-preset').forEach(b => b.classList.remove('active'));
    renderFinanceRange();
    loadFinancePage();
  };

  if (finStartInput) finStartInput.onchange = onFinanceDateChange;
  if (finEndInput) finEndInput.onchange = onFinanceDateChange;

  const addExpenseBtn = document.getElementById('add-expense-btn');
  if (addExpenseBtn) addExpenseBtn.onclick = addExpense;

  const resetExpensesBtn = document.getElementById('reset-expenses-btn');
  if (resetExpensesBtn) resetExpensesBtn.onclick = resetExpenses;
}


async function loadFinancePage() {
  if (financeRange.preset === 'weekly' && !financeRange.start) {
    updateFinanceRange('weekly');
    return;
  }
  try {
    const { start, end } = financeRange;
    const queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];

    await Promise.all([
      loadFinanceIncome(queryRange),
      loadFinanceRemits(queryRange),
      loadFinanceProfits(queryRange),
      loadFinanceExpenses(queryRange)
    ]);
    updateNetIncome();
  } catch (err) {
    console.error('Failed to load finance page', err);
  }
}


async function loadFinanceIncome(queryRange) {
  const totalEl = document.getElementById('fin-total-income');
  if (!totalEl) return;

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalIncome = 0;
    qSnap.forEach(docSnap => { totalIncome += Number(docSnap.data().total || 0); });
    totalEl.innerText = formatCurrency(totalIncome);
  } catch (err) {
    console.error('Failed to load finance income', err);
    totalEl.innerText = 'PHP 0.00';
  }
}


async function loadFinanceRemits(queryRange) {
  const container = document.getElementById('finance-remits-list');
  const capitalEl = document.getElementById('finance-total-capital');
  if (!container || !capitalEl) return;
  container.innerHTML = 'Loading remits...';

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalCapital = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      const amount = Number(s.total || 0);
      totalCapital += amount;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += amount;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales in this range';
    capitalEl.innerText = formatCurrency(totalCapital);
  } catch (err) {
    console.error('Failed to load finance remits', err);
    container.innerText = 'Failed to load remits';
    capitalEl.innerText = 'PHP 0.00';
  }
}


async function loadFinanceProfits(queryRange) {
  const container = document.getElementById('finance-profits-list');
  const profitEl = document.getElementById('finance-total-profit');
  if (!container || !profitEl) return;
  container.innerHTML = 'Loading profits...';

  try {
    const q = query(collection(db, 'sales'), ...queryRange);
    const qSnap = await getDocs(q);
    let totalProfit = 0;
    const dailyTotals = {};

    container.innerHTML = '';
    qSnap.forEach(docSnap => {
      const s = docSnap.data();
      const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
      const day = ts.toDateString();
      let saleProfit = 0;

      (s.items || []).forEach(it => {
        const product = products.find(p => p.name === it.name && p.unit === it.unit);
        if (product && product.profit != null) {
          let quantity = (it.unit && it.unit.toLowerCase() === 'kg') ? Number(it.weight || 0) : Number(it.qty || 0);
          saleProfit += Number(product.profit) * quantity;
        }
      });

      totalProfit += saleProfit;
      if (!dailyTotals[day]) dailyTotals[day] = 0;
      dailyTotals[day] += saleProfit;
    });

    Object.keys(dailyTotals).sort((a, b) => new Date(a) - new Date(b)).forEach(day => {
      const div = document.createElement('div');
      div.innerText = `${day}: ${formatCurrency(dailyTotals[day])}`;
      div.style.padding = '4px 0';
      div.style.fontSize = '14px';
      container.appendChild(div);
    });

    if (qSnap.empty) container.innerText = 'No sales in this range';
    profitEl.innerText = formatCurrency(totalProfit);
  } catch (err) {
    console.error('Failed to load finance profits', err);
    container.innerText = 'Failed to load profits';
    profitEl.innerText = 'PHP 0.00';
  }
}


async function loadFinanceExpenses(queryRange) {
  const container = document.getElementById('expenses-list');
  const totalEl = document.getElementById('weekly-expenses');
  if (!container || !totalEl) return;
  container.innerHTML = 'Loading expenses...';

  if (!queryRange) {
    const { start, end } = financeRange;
    if (start && end) {
      queryRange = [where('timestamp', '>=', start), where('timestamp', '<=', end)];
    } else {
      container.innerHTML = 'No date range selected';
      return;
    }
  }

  try {
    const q = query(collection(db, 'expenses'), ...queryRange, orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    let total = 0;

    container.innerHTML = '';
    if (snap.empty) {
      container.innerHTML = '<div style="color:var(--muted);font-size:14px">No expenses in this range</div>';
    } else {
      snap.forEach(docSnap => {
        const e = docSnap.data();
        total += Number(e.amount || 0);
        const div = document.createElement('div');
        div.className = 'expense-item';
        div.innerHTML = `<span>${e.reason || 'No description'}</span><span>${formatCurrency(e.amount)}</span><button class="remove-btn" onclick="deleteExpense('${docSnap.id}')">Delete</button>`;
        container.appendChild(div);
      });
    }
    totalEl.innerText = formatCurrency(total);
  } catch (err) {
    console.error('Failed to load finance expenses', err);
    container.innerHTML = '<div style="color:var(--danger)">Failed to load expenses</div>';
    totalEl.innerText = 'PHP 0.00';
  }
}

async function addExpense() {
  const amountInput = document.getElementById('expense-amount');
  const reasonInput = document.getElementById('expense-reason');

  const amount = Number(amountInput.value);
  const reason = reasonInput.value.trim();

  if (!amount || amount <= 0) return alert('Please enter a valid amount');
  if (!reason) return alert('Please enter a reason/description');

  try {
    await safeWrite('add', 'expenses', {
      amount: amount,
      reason: reason,
      timestamp: new Date()
    });
    amountInput.value = '';
    reasonInput.value = '';
    await loadFinanceExpenses();
    updateNetIncome();
    alert('Expense added successfully');
  } catch (err) {
    console.error('Failed to add expense', err);
    alert('Failed to add expense');
  }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  try {
    await deleteDoc(doc(db, 'expenses', id));
    await loadFinanceExpenses();
    updateNetIncome();
  } catch (err) {
    console.error('Failed to delete expense', err);
    alert('Failed to delete expense');
  }
}
window.deleteExpense = deleteExpense;

async function resetExpenses() {
  if (!confirm('Reset all expenses for the selected range? This will delete all expense entries in this span.')) return;
  try {
    const q = query(collection(db, 'expenses'), where('timestamp', '>=', financeRange.start), where('timestamp', '<=', financeRange.end));
    const snap = await getDocs(q);
    const deletePromises = [];
    snap.forEach(docSnap => deletePromises.push(safeWrite('delete', 'expenses', null, docSnap.id)));
    await Promise.all(deletePromises);
    await loadFinanceExpenses();
    updateNetIncome();
    alert('Expenses reset successfully');
  } catch (err) {
    console.error('Failed to reset expenses', err);
    alert('Failed to reset expenses');
  }
}

function updateNetIncome() {
  const incomeEl = document.getElementById('fin-total-income');
  const expensesEl = document.getElementById('weekly-expenses');
  const netIncomeEl = document.getElementById('net-income');
  if (!incomeEl || !expensesEl || !netIncomeEl) return;
  const income = parseFloat(incomeEl.innerText.replace('PHP ', '').replace(/,/g, '')) || 0;
  const expenses = parseFloat(expensesEl.innerText.replace('PHP ', '').replace(/,/g, '')) || 0;
  const netIncome = income - expenses;
  netIncomeEl.innerText = formatCurrency(netIncome);
  netIncomeEl.style.color = netIncome >= 0 ? 'var(--accent)' : 'var(--danger)';
}



function parseDateInputToRange(startStr, endStr) {
  if (!startStr && !endStr) return null;
  let start = startStr ? new Date(startStr + 'T00:00:00') : null;
  let end = endStr ? new Date(endStr + 'T23:59:59.999') : null;
  return { start, end };
}


function canCheckout() {

  if (!currentUserRole) return false;
  if (currentUserRole === 'admin') {
    return !!(currentShift && currentShift.id && currentShift.status === 'open');
  }


  if (currentUserRole === 'cashier') {
    return !!(currentShift && currentShift.id && currentShift.status === 'open' && String(currentShift.cashierName || '').trim() === String(currentEmployeeName || '').trim());
  }


  return !!(currentShift && currentShift.id && currentShift.status === 'open');
}

function updateCheckoutButtonState() {
  const btn = document.getElementById('checkout');
  if (!btn) return;
  if (!canCheckout()) {

    btn.classList.add('disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.title = 'You must start a shift before checkout.';
    console.log('Checkout disabled: no active shift for current user', { currentUserRole, currentEmployeeName, currentShift });
  } else {
    btn.classList.remove('disabled');
    btn.removeAttribute('aria-disabled');
    btn.title = 'Proceed to checkout';
    console.log('Checkout enabled');
  }
}

async function loadSalesHistory() {
  const historyEl = document.getElementById('history-list');
  historyEl.innerHTML = '';
  const emptyEl = document.getElementById('history-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  // Always fetch with a simple query to avoid composite index requirements.
  // Filter cashier, shift, and date range entirely client-side.
  const qSnap = await getDocs(query(collection(db, 'sales'), orderBy('timestamp', 'desc')));

  const filterCashier = historyFilters.cashier && historyFilters.cashier !== 'all' && historyFilters.cashier !== 'none' ? historyFilters.cashier : null;
  const filterShift   = historyFilters.shiftId  && historyFilters.shiftId  !== 'all' && historyFilters.shiftId  !== 'none' ? historyFilters.shiftId  : null;
  const rangeStart = historyFilters.startDate ? new Date(historyFilters.startDate + 'T00:00:00') : null;
  const rangeEnd   = historyFilters.endDate   ? new Date(historyFilters.endDate   + 'T23:59:59.999') : null;

  // For cashier role, always restrict to their own sales (fail-closed: no name = no rows).
  const selfName = currentUserRole === 'cashier' ? (currentEmployeeName || currentUsername || '') : null;

  let totalIncome = 0;
  let count = 0;

  qSnap.forEach(docSnap => {
    const s = docSnap.data();

    // Cashier role: show their own sales and CEO's sales. If selfName is empty, show nothing.
    if (selfName !== null && (s.cashier || '') !== selfName && (s.cashier || '') !== 'CEO') return;

    // Cashier dropdown filter (admin).
    if (filterCashier && (s.cashier || '') !== filterCashier) return;

    // Shift filter.
    if (filterShift && (s.shiftId || '') !== filterShift) return;

    // Date range filter.
    const saleTs = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    if (rangeStart && saleTs < rangeStart) return;
    if (rangeEnd   && saleTs > rangeEnd)   return;

    count += 1;
    totalIncome += Number(s.total || 0);

    const li = document.createElement('li');
    li.style.padding = '8px';
    li.style.borderBottom = '1px solid #eee';
    const ts = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    const itemCount = (s.items || []).length;

    const leftDiv = document.createElement('div');
    leftDiv.innerHTML = `<strong>${ts.toLocaleString()}</strong><div style="color:#666">${itemCount} items - Cashier: ${s.cashier || 'Unknown'}</div>`;

    const rightDiv = document.createElement('div');
    rightDiv.style.display = 'flex';
    rightDiv.style.alignItems = 'center';
    rightDiv.style.gap = '8px';

    const totalStrong = document.createElement('strong');
    totalStrong.innerText = formatCurrency(s.total);
    rightDiv.appendChild(totalStrong);

    if (currentUserRole === 'admin') {
      const refundBtn = document.createElement('button');
      refundBtn.className = 'remove-btn';
      refundBtn.innerText = 'Refund';
      refundBtn.onclick = (event) => {
        event.stopPropagation();
        handleRefund(docSnap.id);
      };
      rightDiv.appendChild(refundBtn);
    }

    const mainDiv = document.createElement('div');
    mainDiv.style.display = 'flex';
    mainDiv.style.justifyContent = 'space-between';
    mainDiv.style.alignItems = 'center';
    mainDiv.appendChild(leftDiv);
    mainDiv.appendChild(rightDiv);

    li.appendChild(mainDiv);
    li.onclick = () => openSavedReceiptModal(s);
    historyEl.appendChild(li);
  });

  document.getElementById('filtered-count').innerText = count;
  document.getElementById('filtered-income').innerText = formatCurrency(totalIncome);

  if (count === 0) {
    if (emptyEl) emptyEl.style.display = '';
  }
}

function openSavedReceiptModal(sale) {
  openReceiptModal(sale);
}

async function handleRefund(saleId) {
  if (!confirm('Refund this receipt? Items will be returned to stock.')) return;

  try {
    const saleRef = doc(db, 'sales', saleId);
    const saleSnap = await getDoc(saleRef);

    if (!saleSnap.exists()) {
      alert('Sale record not found.');
      return;
    }

    const saleData = saleSnap.data();
    const items = saleData.items || [];


    const batch = writeBatch(db);



    for (const item of items) {

      const product = products.find(p => p.name === item.name && p.unit === item.unit);
      if (product) {
        let restoreAmount = 0;
        if (item.unit && item.unit.toLowerCase() === 'kg') {
          restoreAmount = Number(item.weight || 0);
        } else {
          restoreAmount = Number(item.qty || 0);
        }

        const productRef = doc(db, 'products', product.id);

        const newStock = Number((Number(product.stock || 0) + restoreAmount).toFixed(2));
        batch.update(productRef, { stock: newStock });
        product.stock = newStock;
      }
    }


    if (saleData.shiftId) {
      const shiftRef = doc(db, 'shifts', saleData.shiftId);
      const shiftSnap = await getDoc(shiftRef);
      if (shiftSnap.exists()) {
        const shiftData = shiftSnap.data();
        const currentTotal = Number(shiftData.totalIncome || shiftData.totalSales || 0);
        const newShiftTotal = Number((currentTotal - Number(saleData.total || 0)).toFixed(2));
        batch.update(shiftRef, { totalIncome: newShiftTotal });
        if (currentShift && currentShift.id === saleData.shiftId) {
          currentShift.totalIncome = newShiftTotal;
        }
      }
    }


    batch.delete(saleRef);


    await batch.commit();

    alert('Refund processed successfully. Stocks restored.');


    loadSalesHistory();
    loadSalesSummary();
    updateShiftUI();
    loadProducts();
  } catch (err) {
    console.error('Refund failed', err);
    alert('Failed to process refund. Check console for details.');
  }
}


window.handleRefund = handleRefund;


let productsEditMode = false;

function renderProductsEditor() {
  const container = document.getElementById('products-edit-list');
  container.innerHTML = '';

  const qSearch = cleanStr(searchState.stocks);
  let displayed;
  if (qSearch) {
    displayed = products.filter(p =>
      cleanStr(p.name).includes(qSearch) ||
      cleanStr(p.category).includes(qSearch)
    );
  } else {
    displayed = products;
  }
  renderEditorGroups(container, displayed);
  const countEl = document.getElementById('total-products-count');
  if (countEl) {
    countEl.textContent = qSearch
      ? displayed.length + ' of ' + products.length + ' products'
      : 'Total: ' + products.length + ' product' + (products.length !== 1 ? 's' : '');
  }
}

function renderEditorGroups(container, productList) {

  const byCat = {};
  productList.forEach(p => {
    const cat = (p.category || 'Uncategorized');
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(p);
  });


  const knownNames = categories.map(c => c.name);
  const foundNames = Object.keys(byCat);
  const allNames = Array.from(new Set([...knownNames, ...foundNames])).sort();

  allNames.forEach(cat => {
    if (!byCat[cat] || byCat[cat].length === 0) return;

    const catHeader = document.createElement('div');
    catHeader.className = 'category-header';
    catHeader.innerText = cat;
    container.appendChild(catHeader);

    const list = document.createElement('div');
    list.className = 'category-list';

    byCat[cat].forEach(p => {
      const id = p.id;
      const row = document.createElement('div');
      row.className = 'product-edit-card';


      const headerDiv = document.createElement('div');
      headerDiv.style.display = 'flex';
      headerDiv.style.justifyContent = 'space-between';
      headerDiv.style.alignItems = 'start';

      const titleDiv = document.createElement('div');
      titleDiv.innerHTML = productsEditMode
        ? `<input type="text" class="edit-name" value="${p.name}" style="font-weight:bold; width:100%; margin-bottom:4px;" />`
        : `<div class="pec-title-row"><h4>${p.name}</h4></div>`;
      if (!productsEditMode) {
        const ps = Number(p.stock || 0);
        const pStockClass = ps <= 0 ? 'pec-stock-out' : ps <= 5 ? 'pec-stock-low' : 'pec-stock-ok';
        const pStockLabel = ps <= 0 ? 'Out of stock' : ps <= 5 ? 'Low: '+ps+' '+p.unit : ps+' '+p.unit;
        const expiryBadge = getExpiryBadgeHtml(p);
        titleDiv.innerHTML += `
          <div class="pec-info-row">
            <span class="pec-price-tag">${formatCurrency(p.price)}</span>
            <span class="pec-stock-tag ${pStockClass}">${pStockLabel}</span>
            <span class="pec-capital-tag">Capital: ${formatCurrency(p.capital || 0)}</span>
            ${expiryBadge}
          </div>
        `;
      } else {
        titleDiv.innerHTML += `<span style="font-size:13px;color:var(--muted)">${p.unit}</span>`;
      }

      headerDiv.appendChild(titleDiv);

      if (productsEditMode) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.id = id;
        cb.style.transform = 'scale(1.2)';
        headerDiv.appendChild(cb);
      }

      row.appendChild(headerDiv);

      if (productsEditMode) {
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'product-edit-inputs';


        let catOptions = `<option value="">No Category</option>`;
        categories.forEach(c => {
          catOptions += `<option value="${c.name}" ${p.category === c.name ? 'selected' : ''}>${c.name}</option>`;
        });

        inputsDiv.innerHTML = `
          <div style="grid-column: span 2;"><label>Category</label>
            <select class="edit-category" style="width:100%">${catOptions}</select>
          </div>
          <div style="grid-column: span 2;"><label>Barcode</label>
            <div style="display:flex;gap:6px">
              <input type="text" class="edit-barcode" placeholder="Scan or type barcode" value="${p.barcode || ''}" style="flex:1" />
              <button type="button" class="quick-btn edit-scan-barcode-btn" title="Scan Barcode"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14M7 5v14M11 5v10M15 5v14M19 5v10M21 5v14"/></svg></button>
            </div>
          </div>
          <div><label>Price</label><input type="number" class="edit-price" step="0.01" value="${Number(p.price).toFixed(2)}" /></div>
          <div><label>Capital</label><input type="number" class="edit-capital" step="0.01" value="${Number(p.capital || 0).toFixed(2)}" /></div>
          <div><label>Stock</label><input type="number" class="edit-stock" step="0.01" min="0" value="${Number(p.stock || 0).toFixed(2)}" /></div>
          <div><label>Profit</label><input type="number" class="edit-profit-display" step="0.01" value="${Number((p.price || 0) - (p.capital || 0)).toFixed(2)}" readonly style="background:var(--input-bg,#f5f5f5);cursor:default;opacity:0.8;" /></div>
          <div style="grid-column: span 2;">
            <label>Expiration Dates</label>
            <div class="edit-expiry-list expiry-list"></div>
            <button type="button" class="quick-btn edit-add-expiry-btn" style="margin-top:6px"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Expiration Date</button>
          </div>
        `;

        const editExpiryList = inputsDiv.querySelector('.edit-expiry-list');
        function addEditExpiryRow(date, qty) {
          const erow = document.createElement('div');
          erow.className = 'expiry-row';
          erow.innerHTML = `
            <input type="date" class="edit-expiry-date-input" value="${date || ''}" />
            <input type="number" class="edit-expiry-qty-input" min="0" step="0.01" placeholder="Qty" value="${qty != null && qty !== '' ? qty : ''}" />
            <button type="button" class="quick-btn expiry-row-remove" title="Remove date"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          `;
          erow.querySelector('.expiry-date-input, .edit-expiry-date-input').addEventListener('change', scheduleAutoSave);
          erow.querySelector('.edit-expiry-qty-input').addEventListener('change', scheduleAutoSave);
          erow.querySelector('.expiry-row-remove').onclick = () => { erow.remove(); scheduleAutoSave(); };
          editExpiryList.appendChild(erow);
        }
        (p.expirationDates || []).forEach(e => addEditExpiryRow(e.date, e.qty));

        // Live profit calculation
        const editPriceIn = inputsDiv.querySelector('.edit-price');
        const editCapitalIn = inputsDiv.querySelector('.edit-capital');
        const editProfitDisplay = inputsDiv.querySelector('.edit-profit-display');
        function updateEditProfit() {
          const ep = parseFloat(editPriceIn.value) || 0;
          const ec = parseFloat(editCapitalIn.value) || 0;
          editProfitDisplay.value = (ep - ec).toFixed(2);
        }
        editPriceIn.addEventListener('input', updateEditProfit);
        editCapitalIn.addEventListener('input', updateEditProfit);

        // Auto-save status label
        const saveStatus = document.createElement('span');
        saveStatus.className = 'edit-save-status';
        inputsDiv.appendChild(saveStatus);

        row.appendChild(inputsDiv);

        // Auto-save on change (blur after edit)
        let _saving = false;
        let _saveTimer = null;
        async function autoSave() {
          if (_saving) return;
          const nameIn = row.querySelector('.edit-name');
          const priceIn = row.querySelector('.edit-price');
          const stockIn = row.querySelector('.edit-stock');
          const capitalIn = row.querySelector('.edit-capital');
          const categoryIn = row.querySelector('.edit-category');
          const barcodeIn = row.querySelector('.edit-barcode');
          const newName = nameIn.value.trim();
          const newPrice = Number(priceIn.value);
          const newStock = Number(stockIn.value);
          const newCapital = Number(capitalIn.value);
          const newCategory = categoryIn.value;
          const newBarcode = barcodeIn ? barcodeIn.value.trim() : (p.barcode || '');
          const newExpirationDates = [];
          editExpiryList.querySelectorAll('.expiry-row').forEach(erow => {
            const edate = erow.querySelector('.edit-expiry-date-input').value;
            const eqty = Number(erow.querySelector('.edit-expiry-qty-input').value) || 0;
            if (edate) newExpirationDates.push({ date: edate, qty: eqty });
          });
          if (!newName || isNaN(newPrice) || newPrice <= 0 || isNaN(newStock) || newStock < 0 || isNaN(newCapital) || newCapital < 0) {
            saveStatus.textContent = '';
            return;
          }
          const newProfit = Number((newPrice - newCapital).toFixed(2));
          _saving = true;
          saveStatus.textContent = 'Saving...';
          saveStatus.style.color = 'var(--muted)';
          try {
            await updateDoc(doc(db, 'products', id), {
              name: newName, price: newPrice, stock: newStock,
              capital: newCapital, profit: newProfit, category: newCategory, barcode: newBarcode,
              expirationDates: newExpirationDates
            });
            // Update in-memory products without full re-render
            const idx = products.findIndex(pr => pr.id === id);
            if (idx !== -1) {
              products[idx] = { ...products[idx], name: newName, price: newPrice,
                stock: newStock, capital: newCapital, profit: newProfit, category: newCategory, barcode: newBarcode,
                expirationDates: newExpirationDates };
            }
            playSfx('success');
            saveStatus.textContent = '\u2713 Saved';
            saveStatus.style.color = 'var(--success, #2ecc71)';
            row.style.background = 'rgba(46, 204, 113, 0.15)';
            setTimeout(() => { row.style.background = ''; saveStatus.textContent = ''; }, 1500);
            loadProducts();
          } catch (err) {
            console.error(err);
            saveStatus.textContent = '\u2717 Error';
            saveStatus.style.color = '#e74c3c';
            setTimeout(() => { saveStatus.textContent = ''; }, 2000);
          } finally {
            _saving = false;
          }
        }
        function scheduleAutoSave() {
          clearTimeout(_saveTimer);
          _saveTimer = setTimeout(autoSave, 600);
        }
        [row.querySelector('.edit-name'), editPriceIn, editCapitalIn,
         inputsDiv.querySelector('.edit-stock'), inputsDiv.querySelector('.edit-category'),
         inputsDiv.querySelector('.edit-barcode')]
          .forEach(el => { if (el) el.addEventListener('change', scheduleAutoSave); });

        const editAddExpiryBtn = inputsDiv.querySelector('.edit-add-expiry-btn');
        if (editAddExpiryBtn) editAddExpiryBtn.onclick = () => addEditExpiryRow('', '');

        const editScanBarcodeBtn = inputsDiv.querySelector('.edit-scan-barcode-btn');
        if (editScanBarcodeBtn) editScanBarcodeBtn.onclick = () => {
          openBarcodeScanner('product-form', (code) => {
            const barcodeIn = row.querySelector('.edit-barcode');
            if (barcodeIn) {
              barcodeIn.value = code;
              scheduleAutoSave();
            }
          });
        };
      }

      list.appendChild(row);
    });

    container.appendChild(list);
  });


  const delBtn = document.getElementById('delete-selected');
  if (delBtn) delBtn.style.display = productsEditMode ? '' : 'none';
}


async function loadEmployees() {
  const container = document.getElementById('admin-employees-list');
  if (!container) return;
  container.innerHTML = '';
  try {
    const qSnap = await getDocs(collection(db, 'employees'));
    if (qSnap.empty) {
      container.innerText = 'No employees yet';
      return;
    }
    qSnap.forEach(docSnap => {
      const d = docSnap.data() || {};
      const row = document.createElement('div');
      row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.marginBottom = '6px';
      const nameEl = document.createElement('strong'); nameEl.innerText = d.name || 'Unnamed';
      const roleEl = document.createElement('span'); roleEl.style.color = 'var(--muted)'; roleEl.style.marginLeft = '8px'; roleEl.innerText = d.role || '';
      const usernameEl = document.createElement('span'); usernameEl.style.color = 'var(--muted)'; usernameEl.style.marginLeft = '8px'; usernameEl.innerText = d.username ? `(${d.username})` : '';
      const removeBtn = document.createElement('button'); removeBtn.className = 'remove-btn'; removeBtn.style.marginLeft = 'auto'; removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        if (!confirm('Delete employee "' + (d.name || '') + '"? This will also delete their login account.')) return;
        try {
          await safeWrite('delete', 'employees', null, docSnap.id);
          if (d.username) {
            const uQ = query(collection(db, 'users'), where('username', '==', d.username));
            const uSnap = await getDocs(uQ);
            for (const uDoc of uSnap.docs) { await safeWrite('delete', 'users', null, uDoc.id); }
          }
          loadEmployees();
          alert('Employee and their login account have been removed.');
        } catch (err) { console.error('Failed to delete employee', err); alert('Failed to delete. See console.'); }
      };
      row.appendChild(nameEl); row.appendChild(usernameEl); row.appendChild(roleEl); row.appendChild(removeBtn);
      container.appendChild(row);
    });
  } catch (err) { console.error('Failed to load employees', err); container.innerText = 'Failed to load employees'; }
}

async function addEmployeeRecord(name, role) {
  if (!name || !name.trim()) throw new Error('Employee name required');
  const r = (role || 'cashier').trim().toLowerCase();
  if (r !== 'admin' && r !== 'cashier') throw new Error('Role must be admin or cashier');

  const q = query(collection(db, 'employees'), where('name', '==', name.trim()));
  const qSnap = await getDocs(q);
  if (!qSnap.empty) throw new Error('duplicate');
  await safeWrite('add', 'employees', { name: name.trim(), role: r, active: true });
}


async function addEmployee() {
  try {
    const name = prompt('Enter employee name (required)');
    if (!name || !name.trim()) return alert('Employee name required');
    const roleInput = prompt("Role ('admin' or 'cashier')", 'cashier') || 'cashier';
    await addEmployeeRecord(name, roleInput);
    alert('Employee added');
    loadEmployees();
    if (typeof loadCashiersList === 'function') loadCashiersList();
  } catch (err) {
    if (err.message === 'duplicate') return alert('Employee with that name already exists');
    console.error('Failed to add employee', err); alert('Failed to add employee. See console.');
  }
}

function openEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  if (!modal) return;
  document.getElementById('new-employee-fullname').value = '';
  document.getElementById('new-employee-username').value = '';
  document.getElementById('new-employee-password').value = '';
  document.getElementById('new-employee-role').value = 'cashier';
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
}

function closeEmployeeModal() {
  const modal = document.getElementById('add-employee-modal');
  if (!modal) return;
  modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true');
}


const addEmployeeCancel = document.getElementById('add-employee-cancel');
if (addEmployeeCancel) addEmployeeCancel.onclick = () => closeEmployeeModal();
const addEmployeeSave = document.getElementById('add-employee-save');
if (addEmployeeSave) addEmployeeSave.onclick = async () => {
  const fullname = document.getElementById('new-employee-fullname').value?.trim();
  const username = document.getElementById('new-employee-username').value?.trim();
  const password = document.getElementById('new-employee-password').value || '';
  const role = document.getElementById('new-employee-role').value;

  if (!fullname || !username || !password || !role) return alert('Please fill all fields');
  if (currentUserRole !== 'admin') return alert('Only admins can create employee accounts.');

  try {

    const userQ = query(collection(db, 'users'), where('username', '==', username));
    const userSnap = await getDocs(userQ);
    if (!userSnap.empty) return alert('Username already exists');


    await safeWrite('add', 'users', { username: username, password: password, role: role, employeeName: fullname, active: true });


    const empQ = query(collection(db, 'employees'), where('username', '==', username));
    const empSnap = await getDocs(empQ);
    if (!empSnap.empty) {
      const empId = empSnap.docs[0].id;
      await safeWrite('update', 'employees', { name: fullname, role: role, username: username, active: true }, empId);
    } else {
      await safeWrite('add', 'employees', { name: fullname, role: role, username: username, active: true });
    }

    alert('Employee & user added');
    closeEmployeeModal();
    loadEmployees();
    if (typeof loadCashiersList === 'function') loadCashiersList();
  } catch (err) {
    console.error('Failed to add employee/user', err);
    alert('Failed to add employee/user. See console.');
  }
};


function openWeightModal(product, editIndex = null, existingWeight = null) {
  modalProduct = product;
  modalEditIndex = (typeof editIndex === 'number') ? editIndex : null;
  isLendingModal = false;
  document.getElementById('modal-product-name').innerText = product.name;
  document.getElementById('modal-price').innerText = Number(product.price).toFixed(2);

  const w = document.getElementById('modal-weight');
  const a = document.getElementById('modal-amount');

  if (existingWeight != null) {
    w.value = Number(existingWeight).toFixed(2);
    a.value = Number((existingWeight * product.price).toFixed(2));
  } else {
    w.value = '';
    a.value = '';
  }

  document.getElementById('weight-modal').classList.remove('hidden');
  document.getElementById('weight-modal').setAttribute('aria-hidden', 'false');
}

function closeWeightModal() {
  const modal = document.getElementById('weight-modal');

  if (document.activeElement && modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
}


const modalWeightInput = document.getElementById('modal-weight');
const modalAmountInput = document.getElementById('modal-amount');

if (modalWeightInput && modalAmountInput) {
  modalWeightInput.oninput = () => {
    const w = Number(modalWeightInput.value);
    if (!modalProduct) return;
    if (!isNaN(w) && w > 0) {
      modalAmountInput.value = Number((w * modalProduct.price).toFixed(2));
    } else {
      modalAmountInput.value = '';
    }
  };

  modalAmountInput.oninput = () => {
    const a = Number(modalAmountInput.value);
    if (!modalProduct) return;
    if (!isNaN(a) && a > 0) {
      modalWeightInput.value = Number((a / modalProduct.price).toFixed(2));
    } else {
      modalWeightInput.value = '';
    }
  };
}


const weightModalClose = document.getElementById('weight-modal-close');
const modalAdd = document.getElementById('modal-add');

if (weightModalClose) weightModalClose.onclick = () => closeWeightModal();

if (modalAdd) modalAdd.onclick = () => {
  if (!modalProduct) return closeWeightModal();

  const wVal = Number(document.getElementById('modal-weight').value);
  const aVal = Number(document.getElementById('modal-amount').value);


  if ((!wVal || wVal <= 0) && (!aVal || aVal <= 0)) {
    closeWeightModal();
    return;
  }


  let weight = null;
  let total = 0;
  if (wVal && wVal > 0) {
    weight = wVal;
    total = Number((weight * modalProduct.price).toFixed(2));
  } else {

    weight = Number((aVal / modalProduct.price).toFixed(3));
    total = Number(aVal.toFixed(2));
  }

  if (isLendingModal) {

    if (modalEditIndex !== null) {

      const item = lendingCart[modalEditIndex];
      if (item && item.unit.toLowerCase() === 'kg') {
        item.weight = weight;
        item.total = total;
      }
    } else {

      let existing = lendingCart.find(item => item.name === modalProduct.name && item.unit && item.unit.toLowerCase() === 'kg');
      if (existing) {
        existing.weight = Number((existing.weight + weight).toFixed(3));
        existing.total = Number((existing.weight * existing.price).toFixed(2));
      } else {
        lendingCart.push({
          name: modalProduct.name,
          price: Number(modalProduct.price),
          unit: 'Kg',
          weight: Number(weight.toFixed(3)),
          total: Number(total.toFixed(2))
        });
      }
    }
    playSfx('add');
    renderLendingCart();
  } else {

    if (modalEditIndex !== null) {

      const item = cart[modalEditIndex];
      if (item && item.unit.toLowerCase() === 'kg') {
        item.weight = weight;
        item.total = total;
      }
    } else {

      let existing = cart.find(item => item.name === modalProduct.name && item.unit && item.unit.toLowerCase() === 'kg');
      if (existing) {
        existing.weight = Number((existing.weight + weight).toFixed(3));
        existing.total = Number((existing.weight * existing.price).toFixed(2));
      } else {
        cart.push({
          name: modalProduct.name,
          price: Number(modalProduct.price),
          unit: 'Kg',
          weight: Number(weight.toFixed(3)),
          total: Number(total.toFixed(2))
        });
      }
    }
    playSfx('add');
    renderCart();
  }
  closeWeightModal();
};


const lendingModalAdd = document.getElementById('lending-modal-add');
const lendingWeightModalClose = document.getElementById('lending-weight-modal-close');

if (lendingWeightModalClose) lendingWeightModalClose.onclick = () => {
  document.getElementById('lending-weight-modal').classList.add('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
};


if (lendingModalAdd) lendingModalAdd.onclick = () => {

  if (!modalProduct) return;

  const wVal = Number(document.getElementById('lending-modal-weight').value);
  const aVal = Number(document.getElementById('lending-modal-amount').value);

  if ((!wVal || wVal <= 0) && (!aVal || aVal <= 0)) return;

  let weight = null;
  let total = 0;


  if (wVal && wVal > 0) {
    weight = wVal;
    total = Number((weight * modalProduct.price).toFixed(2));
  } else {

    weight = Number((aVal / modalProduct.price).toFixed(3));
    total = Number(aVal.toFixed(2));
  }


  let existing = lendingCart.find(
    i => i.name === modalProduct.name && i.unit.toLowerCase() === 'kg'
  );

  if (existing) {
    existing.weight = Number((existing.weight + weight).toFixed(3));
    existing.total = Number((existing.weight * existing.price).toFixed(2));
  } else {
    lendingCart.push({
      name: modalProduct.name,
      price: Number(modalProduct.price),
      unit: 'Kg',
      weight: Number(weight.toFixed(3)),
      total: Number(total.toFixed(2))
    });
  }

  playSfx('add');
  renderLendingCart();


  document.getElementById('lending-weight-modal').classList.add('hidden');
  document.getElementById('lending-weight-modal').setAttribute('aria-hidden', 'true');
  modalProduct = null;
  modalEditIndex = null;
};


const clearBtn = document.getElementById('clear-cart');
if (clearBtn) clearBtn.onclick = clearCart;


function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.classList.add('dark-theme');
  else document.documentElement.classList.remove('dark-theme');
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = '';
    btn.setAttribute('title', theme === 'dark' ? 'Light mode' : 'Dark mode');
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) applyTheme(saved);
  else {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }

  const btn = document.getElementById('theme-toggle');
  if (btn) btn.onclick = () => {
    const isDark = document.documentElement.classList.contains('dark-theme');
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  };
}

initTheme();
loadSoundSettings();


const soundBtn = document.getElementById('sound-toggle');
if (soundBtn) soundBtn.onclick = toggleSound;


const exportBtn = document.getElementById('export-sales');
if (exportBtn) exportBtn.onclick = async () => {
  const qSnap = await getDocs(collection(db, 'sales'));
  const rows = [];
  qSnap.forEach(snap => {
    const s = snap.data();
    (s.items || []).forEach(it => {
      rows.push({ timestamp: s.timestamp, date: s.timestamp && s.timestamp.toDate ? s.timestamp.toDate().toLocaleString() : new Date(s.timestamp).toLocaleString(), name: it.name, unit: it.unit, qty: it.qty || '', weight: it.weight || '', lineTotal: it.lineTotal });
    });
  });

  const header = ['Date', 'Name', 'Unit', 'Qty', 'Weight', 'LineTotal'];
  const csv = [header.join(',')].concat(rows.map(r => [r.date, r.name, r.unit, r.qty, r.weight, (r.lineTotal || '').toFixed ? r.lineTotal.toFixed(2) : r.lineTotal].join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sales_export_${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};

const exportPriceListBtn = document.getElementById('export-price-list');
if (exportPriceListBtn) exportPriceListBtn.onclick = async () => {
  const originalLabel = exportPriceListBtn.textContent;
  exportPriceListBtn.disabled = true;
  exportPriceListBtn.textContent = 'Generating...';
  try {
    await loadProducts();
    const sorted = [...products].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    await exportPriceListDocx(sorted);
  } catch (err) {
    console.error('Failed to export price list', err);
    alert('Failed to generate price list: ' + err.message);
  } finally {
    exportPriceListBtn.disabled = false;
    exportPriceListBtn.textContent = originalLabel;
  }
};

async function exportPriceListDocx(sorted) {
  const docx = await import('https://cdn.jsdelivr.net/npm/docx@9.0.3/+esm');
  const {
    Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
    AlignmentType, WidthType, BorderStyle, VerticalAlign, PageOrientation
  } = docx;

  const FONT = 'Times New Roman';
  const HEADER_FILL = '8B4513';
  const NO_BORDER = { style: BorderStyle.SINGLE, size: 0, color: 'FFFFFF' };
  const CELL_BORDER = { style: BorderStyle.SINGLE, size: 6, color: '000000' };

  const cellBorders = {
    top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER
  };
  const outerCellBorders = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

  const COL_WIDTHS = [600, 2940, 870, 990];

  const makeHeaderCell = (text, width) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders,
    shading: { fill: HEADER_FILL },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text, font: FONT, size: 20, bold: true, color: 'FFFFFF' })]
    })]
  });

  const makeDataCell = (text, width) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), font: FONT, size: 18 })]
    })]
  });

  const buildInnerTable = (items, startIndex) => {
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        makeHeaderCell('No.', COL_WIDTHS[0]),
        makeHeaderCell('Product Name', COL_WIDTHS[1]),
        makeHeaderCell('Unit / Size', COL_WIDTHS[2]),
        makeHeaderCell('Price (\u20b1)', COL_WIDTHS[3])
      ]
    });
    const dataRows = items.map((p, i) => new TableRow({
      children: [
        makeDataCell(startIndex + i + 1, COL_WIDTHS[0]),
        makeDataCell(p.name || '', COL_WIDTHS[1]),
        makeDataCell(p.unit || '', COL_WIDTHS[2]),
        makeDataCell(`\u20b1${Number(p.price || 0).toFixed(2)}`, COL_WIDTHS[3])
      ]
    }));
    return new Table({
      width: { size: 5400, type: WidthType.DXA },
      alignment: AlignmentType.CENTER,
      columnWidths: COL_WIDTHS,
      borders: cellBorders,
      rows: [headerRow, ...dataRows]
    });
  };

  const half = Math.ceil(sorted.length / 2);
  const leftItems = sorted.slice(0, half);
  const rightItems = sorted.slice(half);

  const outerTable = new Table({
    width: { size: 11160, type: WidthType.DXA },
    borders: outerCellBorders,
    columnWidths: [5580, 5580],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 5580, type: WidthType.DXA },
            borders: outerCellBorders,
            margins: { top: 40, bottom: 40, left: 40, right: 140 },
            children: [buildInnerTable(leftItems, 0), new Paragraph({ text: '' })]
          }),
          new TableCell({
            width: { size: 5580, type: WidthType.DXA },
            borders: outerCellBorders,
            margins: { top: 40, bottom: 40, left: 40, right: 140 },
            children: [buildInnerTable(rightItems, half), new Paragraph({ text: '' })]
          })
        ]
      })
    ]
  });

  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const docxDocument = new Document({
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.PORTRAIT, width: 12240, height: 15840 },
          margin: { top: 720, right: 540, bottom: 720, left: 540, header: 360, footer: 360, gutter: 0 }
        }
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'SARI-SARI STORE PRODUCT PRICE LIST', font: FONT, bold: true, size: 36 })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `Date: ${dateStr}`, font: FONT, size: 22 })]
        }),
        new Paragraph({ text: '' }),
        outerTable,
        new Paragraph({ text: '' })
      ]
    }]
  });

  const blob = await Packer.toBlob(docxDocument);
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `stock_price_list_${new Date().toISOString().slice(0, 10)}.docx`;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const clearSalesBtn = document.getElementById('clear-sales');
if (clearSalesBtn) clearSalesBtn.onclick = async () => {
  const confirmText = prompt("Type DELETE to confirm clearing all sales");
  if (confirmText !== 'DELETE') return alert('Delete cancelled');
  const qSnap = await getDocs(collection(db, 'sales'));
  for (const s of qSnap.docs) {
    await deleteDoc(doc(db, 'sales', s.id));
  }
  alert('All sales cleared');
  loadSalesSummary();
  loadSalesHistory();
};


const addProductBtn = document.getElementById('add-product-btn');
const addProductModal = document.getElementById('add-product-modal');
const addProductCancel = document.getElementById('add-product-cancel');
const addProductSave = document.getElementById('add-product-save');
let editingProductId = null;

function calcNewProductProfit() {
  const price = parseFloat(document.getElementById('new-product-price').value) || 0;
  const capital = parseFloat(document.getElementById('new-product-capital').value) || 0;
  document.getElementById('new-product-profit').value = (price - capital).toFixed(2);
}

const newProductPriceInput = document.getElementById('new-product-price');
const newProductCapitalInput = document.getElementById('new-product-capital');
if (newProductPriceInput) newProductPriceInput.addEventListener('input', calcNewProductProfit);
if (newProductCapitalInput) newProductCapitalInput.addEventListener('input', calcNewProductProfit);

function addExpiryRow(date, qty) {
  const list = document.getElementById('new-product-expiry-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'expiry-row';
  row.innerHTML = `
    <input type="date" class="expiry-date-input" value="${date || ''}" />
    <input type="number" class="expiry-qty-input" min="0" step="0.01" placeholder="Qty" value="${qty != null && qty !== '' ? qty : ''}" />
    <button type="button" class="quick-btn expiry-row-remove" title="Remove date"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;
  row.querySelector('.expiry-row-remove').onclick = () => row.remove();
  list.appendChild(row);
}

function resetExpiryRows(entries) {
  const list = document.getElementById('new-product-expiry-list');
  if (!list) return;
  list.innerHTML = '';
  (entries || []).forEach(e => addExpiryRow(e.date, e.qty));
}

function collectExpiryRows() {
  const list = document.getElementById('new-product-expiry-list');
  if (!list) return [];
  const entries = [];
  list.querySelectorAll('.expiry-row').forEach(row => {
    const date = row.querySelector('.expiry-date-input').value;
    const qty = Number(row.querySelector('.expiry-qty-input').value) || 0;
    if (date) entries.push({ date, qty });
  });
  return entries;
}

const newProductAddExpiryBtn = document.getElementById('new-product-add-expiry');
if (newProductAddExpiryBtn) newProductAddExpiryBtn.onclick = () => addExpiryRow('', '');

if (addProductBtn) addProductBtn.onclick = () => {
  document.getElementById('new-product-name').value = '';
  const barcodeInputReset = document.getElementById('new-product-barcode');
  if (barcodeInputReset) barcodeInputReset.value = '';
  document.getElementById('new-product-unit').value = 'pcs';
  document.getElementById('new-product-category').value = '';
  document.getElementById('new-product-price').value = '';
  document.getElementById('new-product-capital').value = '';
  document.getElementById('new-product-profit').value = '';
  document.getElementById('new-product-stock').value = '';
  resetExpiryRows([]);
  addProductModal.classList.remove('hidden');
  addProductModal.setAttribute('aria-hidden', 'false');
};
if (addProductCancel) addProductCancel.onclick = () => {
  editingProductId = null;
  document.querySelector('#add-product-modal .add-product-header h4').textContent = 'Add Product';
  addProductSave.textContent = 'Save Product';
  addProductModal.classList.add('hidden');
  addProductModal.setAttribute('aria-hidden', 'true');
};

if (addProductSave) addProductSave.onclick = async () => {
  const name = document.getElementById('new-product-name').value.trim();
  const barcodeEl = document.getElementById('new-product-barcode');
  const barcode = barcodeEl ? barcodeEl.value.trim() : '';
  const unit = document.getElementById('new-product-unit').value;
  const category = document.getElementById('new-product-category').value.trim();
  const price = Number(document.getElementById('new-product-price').value);
  const capital = Number(document.getElementById('new-product-capital').value) || 0;
  const profit = Number((price - capital).toFixed(2));
  const stock = Number(document.getElementById('new-product-stock').value) || 0;
  const expirationDates = collectExpiryRows();
  if (!name || isNaN(price) || price <= 0) {
    return alert('Provide valid name and numeric price');
  }
  try {
    if (editingProductId) {
      await safeWrite('update', 'products', { name, barcode, unit, category, price, capital, profit, stock, expirationDates }, editingProductId);
    } else {
      await safeWrite('add', 'products', { name, barcode, unit, category, price, capital, profit, stock, expirationDates });
    }
    editingProductId = null;
    document.querySelector('#add-product-modal .add-product-header h4').textContent = 'Add Product';
    addProductSave.textContent = 'Save Product';
    addProductModal.classList.add('hidden');
    addProductModal.setAttribute('aria-hidden', 'true');
    loadProducts();
    renderProductsEditor();
  } catch (err) {
    console.error('Save product failed', err);
    alert('Failed to save product');
  }
};


const toggleEditBtn = document.getElementById('toggle-edit-products');
if (toggleEditBtn) toggleEditBtn.onclick = () => {
  productsEditMode = !productsEditMode;
  toggleEditBtn.classList.toggle('active', productsEditMode);
  toggleEditBtn.innerText = productsEditMode ? 'Done Editing' : 'Edit Stocks';

  if (productsEditMode) {
    toggleEditBtn.classList.remove('remove-btn');
    toggleEditBtn.classList.add('checkout-btn');
  } else {
    toggleEditBtn.classList.add('remove-btn');
    toggleEditBtn.classList.remove('checkout-btn');
  }
  renderProductsEditor();
};


document.getElementById('product-search').oninput = (e) => {
  searchState.sales = e.target.value;
  renderProducts();
};

document.getElementById('lending-product-search').oninput = (e) => {
  searchState.lending = e.target.value;
  renderLendingProducts();
};

document.getElementById('stock-search').oninput = (e) => {
  searchState.stocks = e.target.value;
  renderProductsEditor();
};

let html5QrCodeInstance = null;
let html5QrcodeLoadPromise = null;
let barcodeScannerContext = null;
let barcodeScannerCallback = null;

function loadHtml5Qrcode() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (html5QrcodeLoadPromise) return html5QrcodeLoadPromise;
  html5QrcodeLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load barcode scanner library'));
    document.head.appendChild(script);
  });
  return html5QrcodeLoadPromise;
}

const barcodeScannerModal = document.getElementById('barcode-scanner-modal');
const barcodeScannerStatus = document.getElementById('barcode-scanner-status');

async function openBarcodeScanner(context, callback) {
  barcodeScannerContext = context;
  barcodeScannerCallback = typeof callback === 'function' ? callback : null;
  barcodeScannerModal.classList.remove('hidden');
  barcodeScannerModal.setAttribute('aria-hidden', 'false');
  if (barcodeScannerStatus) barcodeScannerStatus.textContent = 'Loading scanner...';

  try {
    await loadHtml5Qrcode();
  } catch (err) {
    console.error(err);
    if (barcodeScannerStatus) barcodeScannerStatus.textContent = 'Could not load scanner. Check your connection.';
    return;
  }

  if (!html5QrCodeInstance) {
    html5QrCodeInstance = new window.Html5Qrcode('barcode-scanner-view');
  }

  if (barcodeScannerStatus) barcodeScannerStatus.textContent = 'Point your camera at a barcode';

  try {
    await html5QrCodeInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 150 } },
      (decodedText) => handleBarcodeScanResult(decodedText),
      () => {}
    );
  } catch (err) {
    console.error('Camera start failed', err);
    if (barcodeScannerStatus) barcodeScannerStatus.textContent = 'Unable to access camera. Check camera permissions.';
  }
}

async function closeBarcodeScanner() {
  barcodeScannerModal.classList.add('hidden');
  barcodeScannerModal.setAttribute('aria-hidden', 'true');
  if (html5QrCodeInstance) {
    try {
      const state = html5QrCodeInstance.getState ? html5QrCodeInstance.getState() : null;
      if (state === 2 /* SCANNING */) {
        await html5QrCodeInstance.stop();
      }
      html5QrCodeInstance.clear();
    } catch (err) {
      console.error('Failed to stop scanner', err);
    }
  }
}

let _scanBusy = false;
async function handleBarcodeScanResult(decodedText) {
  if (_scanBusy) return;
  _scanBusy = true;
  setTimeout(() => { _scanBusy = false; }, 1200);

  const code = String(decodedText || '').trim();
  const context = barcodeScannerContext;
  const callback = barcodeScannerCallback;

  if (context === 'product-form') {
    if (callback) {
      callback(code);
    } else {
      const barcodeEl = document.getElementById('new-product-barcode');
      if (barcodeEl) barcodeEl.value = code;
    }
    playSfx('add');
    await closeBarcodeScanner();
    return;
  }

  const match = products.find(p => (p.barcode || '').trim() === code);
  if (match) {
    addToCart(match);
    if (barcodeScannerStatus) barcodeScannerStatus.textContent = `Added: ${match.name}`;
    await closeBarcodeScanner();
    const cartPanel = document.querySelector('.right-panel');
    if (cartPanel) cartPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    if (barcodeScannerStatus) barcodeScannerStatus.textContent = `No product found for barcode: ${code}`;
    playSfx('delete');
  }
}

const scanBarcodeBtn = document.getElementById('scan-barcode-btn');
if (scanBarcodeBtn) scanBarcodeBtn.onclick = () => openBarcodeScanner('search');

const cartScanBarcodeBtn = document.getElementById('cart-scan-barcode-btn');
if (cartScanBarcodeBtn) cartScanBarcodeBtn.onclick = () => openBarcodeScanner('cart');

const cartAddItemBtn = document.getElementById('cart-add-item-btn');
if (cartAddItemBtn) cartAddItemBtn.onclick = () => {
  const leftPanel = document.querySelector('.left-panel');
  if (leftPanel) leftPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const searchInput = document.getElementById('product-search');
  if (searchInput) searchInput.focus();
};

const newProductScanBarcodeBtn = document.getElementById('new-product-scan-barcode');
if (newProductScanBarcodeBtn) newProductScanBarcodeBtn.onclick = () => openBarcodeScanner('product-form');

const barcodeScannerCloseBtn = document.getElementById('barcode-scanner-close');
if (barcodeScannerCloseBtn) barcodeScannerCloseBtn.onclick = () => closeBarcodeScanner();

const addCatBtn = document.getElementById('add-category-btn');
if (addCatBtn) addCatBtn.onclick = () => {
  const inp = document.getElementById('new-category-name');
  if (inp && inp.value.trim()) {
    addCategory(inp.value.trim());
    inp.value = '';
  }
};


loadCategories();




const deleteSelectedBtn = document.getElementById('delete-selected');
if (deleteSelectedBtn) deleteSelectedBtn.onclick = async () => {
  const container = document.getElementById('products-edit-list');
  const checks = container.querySelectorAll('input[type="checkbox"]:checked');
  const ids = Array.from(checks).map(c => c.dataset.id).filter(Boolean);
  if (ids.length === 0) return alert('No products selected');
  const confirmText = prompt('Type DELETE to confirm removing selected products');
  if (confirmText !== 'DELETE') return alert('Delete cancelled');
  for (const id of ids) {
    try { await safeWrite('delete', 'products', null, id); } catch (e) { console.error('Delete failed', e); }
  }
  alert('Selected products removed');
  productsEditMode = false;
  toggleEditBtn.textContent = 'Edit Stocks';
  renderProductsEditor();
  loadProducts();
};




loadProducts();


initShift();





function updateNavAccess() {

  document.querySelectorAll('.nav-btn').forEach(b => {
    const txt = b.innerText.trim();
    if (currentUserRole === 'cashier') {

      if (txt === 'Stocks' || txt === 'Products' || txt === 'Admin' || txt === 'Remits' || txt === 'Profits' || txt === 'Finance' || txt === 'Lending') b.style.display = 'none';
      else b.style.display = 'inline-block';
    } else if (currentUserRole === 'admin') {

      if (txt === 'Cashier' || txt === 'Remits' || txt === 'Profits') b.style.display = 'none';
      else b.style.display = 'inline-block';
    } else {

      b.style.display = 'inline-block';
    }
  });

  // Sidebar links — role-based visibility
  document.querySelectorAll('.sidebar-link').forEach(b => {
    const pageId = b.getAttribute('data-page');
    if (currentUserRole === 'cashier') {
      const allowed = ['salesPage', 'receiptsPage', 'cashierPage', 'eloadingPage'];
      b.style.display = allowed.includes(pageId) ? '' : 'none';
    } else if (currentUserRole === 'admin') {
      const hiddenForAdmin = ['cashierPage', 'remitsPage', 'profitsPage'];
      b.style.display = hiddenForAdmin.includes(pageId) ? 'none' : '';
    } else {
      b.style.display = 'none';
    }
  });


  const cashierPageEl = document.getElementById('cashierPage');
  if (cashierPageEl && cashierPageEl.style.display !== 'none' && !isPageAllowedForRole('cashierPage')) {
    showPage('salesPage');
  }


  const empListEl = document.getElementById('admin-employees-list');
  const empCard = empListEl ? empListEl.parentElement : null;
  if (empCard) {
    empCard.style.display = (currentUserRole === 'admin') ? '' : 'none';
  }

  const notifBellEl = document.getElementById('notif-bell-btn');
  if (notifBellEl) {
    notifBellEl.classList.toggle('notif-bell-hidden', currentUserRole === 'cashier');
  }
}


function updateSidebarUserCard() {
  const card = document.getElementById('sidebar-user-card');
  const avatarEl = document.getElementById('sidebar-user-avatar');
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role-badge');
  if (!card) return;
  if (!currentUserRole) { card.style.display = 'none'; return; }
  const displayName = currentEmployeeName || currentUsername || 'User';
  if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = displayName;
  if (roleEl) {
    roleEl.textContent = currentUserRole.charAt(0).toUpperCase() + currentUserRole.slice(1);
    roleEl.className = 'sidebar-user-role-badge role-' + currentUserRole;
  }
  card.style.display = 'flex';
}
function showLogin() {
  const login = document.getElementById('loginPage');
  if (login) { login.classList.remove('hidden'); login.classList.remove('page-hidden'); login.classList.add('page-active'); login.style.display = 'flex'; }
  const container = document.querySelector('.container');
  if (container) container.style.display = 'none';
  const nav = document.getElementById('nav-links');
  if (nav) nav.style.display = 'none';
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) { logoutBtn.classList.add('hidden'); logoutBtn.style.display = ''; }
  const hbg = document.getElementById('hamburger');
  if (hbg) hbg.style.display = 'none';
  const hm = document.getElementById('hamburger-menu');
  if (hm) hm.classList.remove('open');
  const headerEl = document.querySelector('header');
  if (headerEl) headerEl.style.display = 'none';
  document.body.style.paddingTop = '0';
  document.body.style.paddingLeft = '0';
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) sidebarEl.style.display = 'none';
  const userCard = document.getElementById('sidebar-user-card');
  if (userCard) userCard.style.display = 'none';
  const topbarEl = document.getElementById('topbar');
  if (topbarEl) topbarEl.style.display = 'none';


  updateCheckoutButtonState();
}

function hideLogin() {
  const login = document.getElementById('loginPage');
  if (login) { login.classList.add('hidden'); login.classList.remove('page-active'); login.style.display = 'none'; }
  const container = document.querySelector('.container');
  if (container) container.style.display = 'block';
  const nav = document.getElementById('nav-links');
  if (nav) nav.style.display = 'flex';
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) { logoutBtn.classList.remove('hidden'); logoutBtn.style.display = ''; }
  const hbg = document.getElementById('hamburger');
  if (hbg) hbg.style.display = 'inline-flex';
  const headerEl = document.querySelector('header');
  if (headerEl) headerEl.style.display = 'none';
  const sidebarEl2 = document.getElementById('sidebar');
  if (sidebarEl2) sidebarEl2.style.display = 'flex';
  const topbarEl2 = document.getElementById('topbar');
  if (topbarEl2) topbarEl2.style.display = 'flex';
  updateSidebarUserCard();
  if (window.innerWidth > 768) {
    document.body.style.paddingLeft = '240px';
  } else {
    document.body.style.paddingLeft = '0';
  }
  document.body.style.paddingTop = '56px';
}


function saveSession() {
  try {
    const data = { role: currentUserRole, username: currentUsername, employeeName: currentEmployeeName, ts: Date.now() };
    localStorage.setItem('pos_session', JSON.stringify(data));
  } catch (e) { console.warn('Failed to save session', e); }
}
function clearSession() { try { localStorage.removeItem('pos_session'); } catch (e) { } }
async function tryRestoreSession() {
  try {
    const s = localStorage.getItem('pos_session');
    if (!s) { showLogin(); return false; }
    const obj = JSON.parse(s);
    if (obj && obj.role && obj.username) {
      // Validate the user account still exists in the database
      const uQ = query(collection(db, 'users'), where('username', '==', obj.username), limit(1));
      const uSnap = await getDocs(uQ);
      if (uSnap.empty) {
        // Account was deleted — clear session and show login
        clearSession();
        showLogin();
        return false;
      }
      // For cashier accounts, also verify employee record exists
      if (obj.role === 'cashier') {
        const empQ = query(collection(db, 'employees'), where('username', '==', obj.username));
        const empSnap = await getDocs(empQ);
        if (empSnap.empty) {
          clearSession();
          showLogin();
          return false;
        }
      }
      currentUserRole = obj.role;
      currentUsername = obj.username || null;
      currentEmployeeName = obj.role === 'admin' ? 'CEO' : (obj.employeeName || null);
      updateNavAccess();
      hideLogin();
      showPage('salesPage');

      updateCheckoutButtonState();
      return true;
    }
  } catch (err) { console.warn('Failed to restore session', err); }
  showLogin();
  return false;
}


const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.onclick = () => { currentUserRole = null; currentUsername = null; currentEmployeeName = null; updateNavAccess(); clearSession(); showLogin(); };

const loginBtn = document.getElementById('login-btn');
if (loginBtn) loginBtn.onclick = async () => {
  const username = document.getElementById('login-username')?.value.trim();
  const pwd = document.getElementById('login-password')?.value.trim();
  if (!username) return alert('Enter username');
  if (!pwd) return alert('Enter password');
  try {
    const q = query(collection(db, 'users'), where('username', '==', username), limit(1));
    const qSnap = await getDocs(q);
    if (!qSnap.empty) {
      const d = qSnap.docs[0];
      const u = d.data() || {};
      if ((u.password || '') !== pwd) {
        return alert('Invalid password');
      }
      const userRole = u.role || 'cashier';
      // For cashier accounts, verify the employee record still exists
      if (userRole === 'cashier') {
        const empQ = query(collection(db, 'employees'), where('username', '==', username));
        const empSnap = await getDocs(empQ);
        if (empSnap.empty) {
          // Orphaned user — employee was deleted. Clean up and block login.
          try { await safeWrite('delete', 'users', null, d.id); } catch (_) {}
          return alert('This account has been removed. Please contact your admin.');
        }
      }
      currentUserRole = userRole;
      currentUsername = u.username || username;
      currentEmployeeName = userRole === 'admin' ? 'CEO' : (u.employeeName || u.username || username);
      updateNavAccess();

      hideLogin();
      const container = document.querySelector('.container'); if (container) container.style.display = 'block';
      const nav = document.getElementById('nav-links'); if (nav) nav.style.display = 'flex';
      const logoutBtnEl = document.getElementById('logout-btn'); if (logoutBtnEl) { logoutBtnEl.classList.remove('hidden'); logoutBtnEl.style.display = ''; }

      const usrEl = document.getElementById('login-username'); if (usrEl) usrEl.value = '';
      const pwdEl = document.getElementById('login-password'); if (pwdEl) pwdEl.value = '';

      showPage('salesPage');

      const remember = document.getElementById('remember-me')?.checked;
      if (remember) saveSession();
    } else {
      alert('Invalid username');
    }
  } catch (err) {
    console.error('Login failed', err);
    alert('Login failed. See console.');
  }
};


const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');

if (usernameInput) {
  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginBtn.click();
    }
  });
}

if (passwordInput) {
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loginBtn.click();
    }
  });
}




tryRestoreSession();


const startDateInput = document.getElementById('filter-start-date');
const endDateInput = document.getElementById('filter-end-date');
const quickToday = document.getElementById('quick-today');
const quickWeek = document.getElementById('quick-week');
const quickMonth = document.getElementById('quick-month');
const shiftFilter = document.getElementById('shift-filter');
const exportHistoryBtn = document.getElementById('export-history-csv');

if (startDateInput) startDateInput.onchange = () => { historyFilters.startDate = startDateInput.value || null; loadSalesHistory(); };
if (endDateInput) endDateInput.onchange = () => { historyFilters.endDate = endDateInput.value || null; loadSalesHistory(); };

if (quickToday) quickToday.onclick = () => {
  const today = new Date();
  const d = today.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = d;
  if (endDateInput) endDateInput.value = d;
  historyFilters.startDate = d; historyFilters.endDate = d; loadSalesHistory();
};
if (quickWeek) quickWeek.onclick = () => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - (now.getDay() || 7) + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = s; if (endDateInput) endDateInput.value = e;
  historyFilters.startDate = s; historyFilters.endDate = e; loadSalesHistory();
};
if (quickMonth) quickMonth.onclick = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (startDateInput) startDateInput.value = s; if (endDateInput) endDateInput.value = e;
  historyFilters.startDate = s; historyFilters.endDate = e; loadSalesHistory();
};

if (shiftFilter) shiftFilter.onchange = () => { historyFilters.shiftId = shiftFilter.value; loadSalesHistory(); };

if (exportHistoryBtn) exportHistoryBtn.onclick = async () => {

  // Fetch all sales then filter client-side to avoid composite index requirements.
  const qSnap = await getDocs(query(collection(db, 'sales'), orderBy('timestamp', 'desc')));
  const range = parseDateInputToRange(historyFilters.startDate, historyFilters.endDate);
  const rangeStart = range && range.start ? range.start : null;
  const rangeEnd   = range && range.end   ? range.end   : null;

  // Cashier role: always restrict to their own sales (fail-closed: no name = no rows).
  const selfName = currentUserRole === 'cashier' ? (currentEmployeeName || currentUsername || '') : null;

  // Admin: respect the cashier dropdown filter.
  const filterCashier = (currentUserRole !== 'cashier' && historyFilters.cashier && historyFilters.cashier !== 'all' && historyFilters.cashier !== 'none') ? historyFilters.cashier : null;

  // Shift filter.
  const filterShift = (historyFilters.shiftId && historyFilters.shiftId !== 'all' && historyFilters.shiftId !== 'none') ? historyFilters.shiftId : null;

  const rows = [];
  qSnap.forEach(snap => {
    const s = snap.data() || {};

    // Cashier role: only export their own sales. If selfName is empty, export nothing.
    if (selfName !== null && (s.cashier || '') !== selfName) return;

    // Admin cashier dropdown filter.
    if (filterCashier && (s.cashier || '') !== filterCashier) return;

    // Shift filter.
    if (filterShift && (s.shiftId || '') !== filterShift) return;

    // Date range filter.
    const saleTs = s.timestamp && s.timestamp.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    if (rangeStart && saleTs < rangeStart) return;
    if (rangeEnd   && saleTs > rangeEnd)   return;

    const ts = saleTs.toISOString();
    (s.items || []).forEach(it => {
      const qtyOrWeight = (it.unit && it.unit.toLowerCase() === 'kg') ? (it.weight || '') : (it.qty || '');
      rows.push({ timestamp: ts, cashier: s.cashier || '', saleTotal: Number(s.total || 0).toFixed(2), saleDiscount: Number(s.discount || 0).toFixed(2), itemName: it.name || '', unit: it.unit || '', quantityOrWeight: qtyOrWeight, pricePerUnit: (it.price || '').toFixed ? (it.price || '').toFixed(2) : it.price, lineTotal: (it.lineTotal || '').toFixed ? (it.lineTotal || '').toFixed(2) : it.lineTotal });
    });
  });


  const header = ['CASHIER', 'ITEM NAME', 'UNIT', 'DISCOUNT', 'QUANTITY', 'PRICE PER UNIT', 'LINE TOTAL'];
  const csvRows = [header.join(',')].concat(rows.map(r => [r.cashier, r.itemName, r.unit, r.saleDiscount, r.quantityOrWeight, r.pricePerUnit, r.lineTotal].map(v => typeof v === 'string' ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')));
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `history_export_${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
};


loadShiftsDropdown();

const startShiftBtnCashier = document.getElementById('start-shift-btn-cashier');
const startShiftBtnAdmin = document.getElementById('start-shift-btn-admin');
const endShiftBtnCashier = document.getElementById('end-shift-btn-cashier');
const endShiftBtnAdmin = document.getElementById('end-shift-btn-admin');

if (startShiftBtnCashier) startShiftBtnCashier.onclick = () => startNewShift();
if (startShiftBtnAdmin) startShiftBtnAdmin.onclick = () => startNewShift();
if (endShiftBtnCashier) endShiftBtnCashier.onclick = () => endCurrentShift();
if (endShiftBtnAdmin) endShiftBtnAdmin.onclick = () => endCurrentShift();

const adminAddEmployeeBtn = document.getElementById('admin-add-employee');
if (adminAddEmployeeBtn) adminAddEmployeeBtn.onclick = () => openEmployeeModal();


loadSalesHistory();


function loadBorrowersList() {
  const container = document.getElementById('borrowers-list');
  if (!container) return;
  container.innerHTML = 'Loading borrowers...';


  const q = query(collection(db, 'lendings'), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    const borrowers = {};
    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const name = l.borrowerName;
      if (!borrowers[name]) borrowers[name] = { total: 0, paid: 0, lendings: [] };
      borrowers[name].lendings.push({ id: docSnap.id, ...l });
      borrowers[name].total += Number(l.total || 0);

      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      borrowers[name].paid += paid;
    });

    container.innerHTML = '';
    Object.keys(borrowers).forEach(name => {
      const b = borrowers[name];
      const unpaid = b.total - b.paid;
      if (unpaid > 0) {
        const div = document.createElement('div');
        div.className = 'borrower-item card';
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';

        const nameEl = document.createElement('strong');
        nameEl.innerText = name;

        const actions = document.createElement('div');

        const unpaidEl = document.createElement('span');
        unpaidEl.style.color = 'var(--danger)';
        unpaidEl.innerText = `Unpaid: ${formatCurrency(unpaid)}`;

        const detailsBtn = document.createElement('button');
        detailsBtn.className = 'checkout-btn';
        detailsBtn.innerText = 'View Details';
        detailsBtn.onclick = () => showBorrowerDetails(name);

        actions.appendChild(unpaidEl);
        actions.appendChild(detailsBtn);
        row.appendChild(nameEl);
        row.appendChild(actions);
        div.appendChild(row);
        container.appendChild(div);
      }
    });

    if (container.innerHTML === '') {
      container.innerText = 'No borrowers with outstanding balance';
    }
  }).catch(err => {
    console.error('Failed to load borrowers', err);
    container.innerText = 'Failed to load borrowers';
  });
}

function showBorrowerDetails(borrowerName) {
  const modal = document.getElementById('lending-details-modal');
  const borrowerNameEl = document.getElementById('lending-details-name');
  const itemsEl = document.getElementById('lending-details-entries-container');
  const totalEl = document.getElementById('lending-details-balance');

  borrowerNameEl.innerText = borrowerName;
  itemsEl.innerHTML = 'Loading...';

  const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    let totalUnpaid = 0;
    itemsEl.innerHTML = '';

    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;
      if (unpaid > 0) {
        totalUnpaid += unpaid;
        const lendingDiv = document.createElement('div');
        lendingDiv.innerHTML = `<h4>Lending on ${toDisplayDate(l.timestamp).toLocaleString()}</h4>`;
        const itemsList = document.createElement('ul');
        (l.items || []).forEach(item => {
          if (!item.paid) {
            const li = document.createElement('li');
            const qtyStr = item.unit && item.unit.toLowerCase() === 'kg' ? `${Number(item.weight).toFixed(2)}kg` : `x${item.qty}`;
            li.innerText = `${item.name} ${qtyStr} = ${formatCurrency(item.total)}`;
            itemsList.appendChild(li);
          }
        });
        lendingDiv.appendChild(itemsList);
        lendingDiv.innerHTML += `<p>Total Unpaid: ${formatCurrency(unpaid)}</p>`;
        itemsEl.appendChild(lendingDiv);
      }
    });

    totalEl.innerText = formatCurrency(totalUnpaid);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }).catch(err => {
    console.error('Failed to load borrower details', err);
    alert('Failed to load details');
  });
}

function closeLendingDetailsModal() {
  const modal = document.getElementById('lending-details-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}


const lendingDetailsCloseBtn = document.getElementById('lending-details-close');
if (lendingDetailsCloseBtn) lendingDetailsCloseBtn.onclick = () => closeLendingDetailsModal();

const lendingDetailsCancelBtn = document.getElementById('lending-details-cancel');
if (lendingDetailsCancelBtn) lendingDetailsCancelBtn.onclick = () => closeLendingDetailsModal();

const lendingFullBtn = document.getElementById('lending-details-full-payment');
if (lendingFullBtn) lendingFullBtn.onclick = () => {
  const name = document.getElementById('lending-details-name').innerText;
  fullPayment(name);
};

const lendingPartialBtn = document.getElementById('lending-details-partial-payment');
if (lendingPartialBtn) lendingPartialBtn.onclick = () => {
  const name = document.getElementById('lending-details-name').innerText;
  openPaymentModal(name);
};


window.showBorrowerDetails = showBorrowerDetails;

function openPaymentModal(borrowerName) {
  const modal = document.getElementById('payment-modal');
  const borrowerNameEl = document.getElementById('payment-borrower-name');
  const itemsEl = document.getElementById('payment-items');
  const unpaidTotalEl = document.getElementById('payment-unpaid-total');
  const amountInput = document.getElementById('payment-amount');
  if (!modal || !borrowerNameEl || !itemsEl || !unpaidTotalEl || !amountInput) {
    console.error('Payment modal elements are missing from the page');
    alert('Payment modal is unavailable. Please reload the page.');
    return;
  }

  borrowerNameEl.innerText = borrowerName;
  itemsEl.innerHTML = 'Loading...';
  amountInput.value = '';


  const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
  getDocs(q).then(qSnap => {
    let allItems = [];
    let totalUnpaid = 0;

    qSnap.forEach(docSnap => {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;
      if (unpaid > 0) {
        (l.items || []).forEach((item, idx) => {
          if (!item.paid) {
            allItems.push({
              lendingId: docSnap.id,
              itemIndex: idx,
              item: item,
              lendingTotal: unpaid
            });
            totalUnpaid += Number(item.total || 0);
          }
        });
      }
    });

    itemsEl.innerHTML = '';
    allItems.forEach((entry, globalIdx) => {
      const item = entry.item;
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.gap = '8px';
      div.style.marginBottom = '4px';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.lendingId = entry.lendingId;
      checkbox.dataset.itemIndex = entry.itemIndex;
      checkbox.dataset.amount = item.total;
      checkbox.onchange = () => {
        const allChecked = itemsEl.querySelectorAll('input[type="checkbox"]:checked');
        let sum = 0;
        allChecked.forEach(c => sum += Number(c.dataset.amount || 0));
        amountInput.value = sum > 0 ? sum.toFixed(2) : '';
      };

      const label = document.createElement('label');
      const qtyStr = item.unit && item.unit.toLowerCase() === 'kg' ? `${Number(item.weight).toFixed(2)}kg` : `x${item.qty}`;
      label.innerText = `${item.name} ${qtyStr} = ${formatCurrency(item.total)}`;

      div.appendChild(checkbox);
      div.appendChild(label);
      itemsEl.appendChild(div);
    });

    unpaidTotalEl.innerText = formatCurrency(totalUnpaid);

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }).catch(err => {
    console.error('Failed to load payment items', err);
    alert('Failed to load payment details');
  });
}

function closePaymentModal() {
  const modal = document.getElementById('payment-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function fullPayment(borrowerName) {
  const unpaid = Number(document.getElementById('lending-details-balance').innerText.replace('PHP ', '').replace(',', ''));
  if (!confirm(`Pay full amount of ${formatCurrency(unpaid)}?`)) return;
  processPayment(borrowerName, unpaid, true);
}

function partialPayment(borrowerName) {
  openPaymentModal(borrowerName);
}

async function processPayment(borrowerName, amount, isFull, selectedItems = []) {
  if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
    alert('No open shift. Please start a shift before processing payments.');
    return;
  }

  try {

    const q = query(collection(db, 'lendings'), where('borrowerName', '==', borrowerName), where('returned', '==', false));
    const qSnap = await getDocs(q);

    let totalPaid = 0;
    const updates = [];

    for (const docSnap of qSnap.docs) {
      const l = docSnap.data();
      const paid = (l.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const unpaid = Number(l.total || 0) - paid;

      if (unpaid > 0) {
        const paymentRecord = {
          amount: isFull ? unpaid : amount,
          timestamp: new Date(),
          shiftId: currentShift.id,
          cashier: currentEmployeeName || currentUsername || 'Unknown'
        };

        if (isFull) {

          const updatedItems = (l.items || []).map(item => ({ ...item, paid: true }));
          updates.push({
            docId: docSnap.id,
            data: {
              payments: [...(l.payments || []), paymentRecord],
              returned: true,
              items: updatedItems
            }
          });
          totalPaid += unpaid;
        } else {

          const updatedItems = (l.items || []).map((item, idx) => {
            const isSelected = selectedItems.some(s => s.lendingId === docSnap.id && s.itemIndex == idx);
            return isSelected ? { ...item, paid: true } : item;
          });
          updates.push({
            docId: docSnap.id,
            data: {
              payments: [...(l.payments || []), paymentRecord],
              items: updatedItems
            }
          });
          totalPaid += amount;
        }

        if (totalPaid >= amount) break;
      }
    }


    for (const update of updates) {
      await safeWrite('update', 'lendings', update.data, update.docId);
    }


    const saleDoc = {
      timestamp: new Date(),
      shiftId: currentShift.id,
      items: [{ name: `Lending Payment - ${borrowerName}`, unit: 'pcs', price: amount, qty: 1, lineTotal: amount }],
      subtotal: amount,
      discount: 0,
      total: amount,
      cash: amount,
      change: 0,
      cashier: currentEmployeeName || currentUsername || 'Unknown'
    };
    await safeWrite('add', 'sales', saleDoc);


    const newTotal = Number(((Number(currentShift.totalIncome || currentShift.totalSales || 0) + amount)).toFixed(2));
    await safeWrite('update', 'shifts', { totalIncome: newTotal }, currentShift.id);
    currentShift.totalIncome = newTotal;

    alert('Payment recorded successfully!');
    closePaymentModal();
    closeLendingDetailsModal();
    loadBorrowersList();
    loadSalesSummary();
    updateShiftUI();
  } catch (err) {
    console.error('Failed to process payment', err);
    alert('Failed to process payment. Check console.');
  }
}


const paymentCancel = document.getElementById('payment-cancel');
if (paymentCancel) paymentCancel.onclick = () => closePaymentModal();

const paymentFull = document.getElementById('payment-full');
if (paymentFull) paymentFull.onclick = () => {
  const borrowerName = document.getElementById('payment-borrower-name').innerText;
  fullPayment(borrowerName);
};

const paymentConfirm = document.getElementById('payment-confirm');
if (paymentConfirm) paymentConfirm.onclick = () => {
  const name = document.getElementById('payment-borrower-name').innerText;
  const amount = Number(document.getElementById('payment-amount').value);
  const container = document.getElementById('payment-items');
  if (!container) return;
  const checks = container.querySelectorAll('input[type="checkbox"]:checked');
  const selectedItems = Array.from(checks).map(c => ({
    lendingId: c.dataset.lendingId,
    itemIndex: Number(c.dataset.itemIndex)
  }));

  if (isNaN(amount) || amount <= 0) {
    return alert('Please enter a valid payment amount');
  }
  if (!confirm(`Confirm payment of ${formatCurrency(amount)}?`)) return;
  processPayment(name, amount, false, selectedItems);
};




function applyButtonIcons() {
  const map = {
    'checkout': 'Checkout',
    'add-product-btn': 'Add New Product',
    'toggle-edit-products': 'Edit Stocks',
    'delete-selected': 'Delete Selected',
    'start-shift-btn-cashier': 'Start New Shift',
    'start-shift-btn-admin': 'Start New Shift',
    'end-shift-btn-cashier': 'End Shift',
    'end-shift-btn-admin': 'End Shift',
    'export-sales': 'Export Sales (CSV)',
    'clear-sales': 'Clear All Sales',
    'admin-add-employee': 'Add Employee',
    'receipt-save': 'Add to Sales',
    'receipt-cancel': 'Cancel',
    'weight-modal-close': '',
    'lending-weight-modal-close': '',
    'modal-add': 'Add',
    'add-product-save': 'Save',
    'add-product-cancel': 'Cancel',
    'clear-cart': 'Clear Cart'
  };
  Object.keys(map).forEach(id => {
    try {
      const el = document.getElementById(id);
      if (el) {

        if (el.tagName && el.tagName.toUpperCase() === 'INPUT') {

          el.value = String(map[id]).replace(/<[^>]*>/g, '').trim();
        } else {
          el.innerHTML = map[id];
        }
      }
    } catch (err) {
      console.error('applyButtonIcons failed for id', id, 'content:', map[id], err);
    }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setupMojibakeGuard(), { once: true });
} else {
  setupMojibakeGuard();
}

try { applyButtonIcons(); } catch (err) { console.error('applyButtonIcons failed at runtime', err); }
try { initFinanceListeners(); } catch (err) { console.error('initFinanceListeners failed at runtime', err); }

// ═══════════════════════════════════════════════════════
// eLOADING MODULE
// ═══════════════════════════════════════════════════════

let _eloadSelectedType = 'gcash-cashin';
let _eloadProvider    = 'gcash';
let _eloadDirection   = 'cashin';
let _eloadSaving = false;

const CASH_TRANSFER_PROVIDERS = ['gcash', 'maya', 'bank'];

function _updateEloadType() {
  if (CASH_TRANSFER_PROVIDERS.includes(_eloadProvider)) {
    _eloadSelectedType = _eloadProvider + '-' + _eloadDirection;
  } else {
    _eloadSelectedType = _eloadProvider;
  }
  const dirRow = document.getElementById('eload-direction-row');
  if (dirRow) dirRow.style.display = CASH_TRANSFER_PROVIDERS.includes(_eloadProvider) ? 'flex' : 'none';
}

const ELOAD_TYPES = {
  'gcash-cashin':  { label: 'GCash Cash-in',  color: '#00a8e0' },
  'gcash-cashout': { label: 'GCash Cash-out', color: '#00a8e0' },
  'maya-cashin':   { label: 'Maya Cash-in',   color: '#00a651' },
  'maya-cashout':  { label: 'Maya Cash-out',  color: '#00a651' },
  'bank-cashin':   { label: 'Bank Cash-in',   color: '#f59e0b' },
  'bank-cashout':  { label: 'Bank Cash-out',  color: '#f59e0b' },
  'wifi-load':     { label: 'WiFi Load',      color: '#7c3aed' },
  'data-load':     { label: 'Data Load',      color: '#059669' }
};

function eloadTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function getWeekRangeStr(now = new Date()) {
  const start = new Date(now);
  start.setDate(now.getDate() - (now.getDay() || 7) + 1);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function getMonthRangeStr(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function formatDateRangeLabel(start, end) {
  return start === end ? start : (start + ' to ' + end);
}

async function loadEloadingPage() {
  // Wire provider buttons
  document.querySelectorAll('[data-provider]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-provider]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _eloadProvider = btn.dataset.provider;
      _updateEloadType();
    };
  });
  // Wire cash-in / cash-out direction buttons
  document.querySelectorAll('[data-dir]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-dir]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _eloadDirection = btn.dataset.dir;
      _updateEloadType();
    };
  });
  _updateEloadType(); // set initial state

  // Date range filter
  const startInput = document.getElementById('eload-filter-start-date');
  const endInput = document.getElementById('eload-filter-end-date');
  if (startInput && !startInput.value) startInput.value = eloadTodayStr();
  if (endInput && !endInput.value) endInput.value = eloadTodayStr();
  if (startInput) startInput.onchange = loadEloadTransactions;
  if (endInput) endInput.onchange = loadEloadTransactions;

  // Quick range buttons
  const dailyBtn = document.getElementById('eload-daily-btn');
  if (dailyBtn) dailyBtn.onclick = () => {
    const d = eloadTodayStr();
    if (startInput) startInput.value = d;
    if (endInput) endInput.value = d;
    loadEloadTransactions();
  };
  const weeklyBtn = document.getElementById('eload-weekly-btn');
  if (weeklyBtn) weeklyBtn.onclick = () => {
    const range = getWeekRangeStr();
    if (startInput) startInput.value = range.start;
    if (endInput) endInput.value = range.end;
    loadEloadTransactions();
  };
  const monthlyBtn = document.getElementById('eload-monthly-btn');
  if (monthlyBtn) monthlyBtn.onclick = () => {
    const range = getMonthRangeStr();
    if (startInput) startInput.value = range.start;
    if (endInput) endInput.value = range.end;
    loadEloadTransactions();
  };

  // Save button
  const saveBtn = document.getElementById('eload-save-btn');
  if (saveBtn) saveBtn.onclick = saveEloadTransaction;

  loadEloadTransactions();
}

async function loadEloadTransactions() {
  const startInput = document.getElementById('eload-filter-start-date');
  const endInput = document.getElementById('eload-filter-end-date');
  const filterStart = (startInput && startInput.value) ? startInput.value : eloadTodayStr();
  const filterEnd = (endInput && endInput.value) ? endInput.value : eloadTodayStr();

  const historyEl = document.getElementById('eload-history');
  if (historyEl) historyEl.innerHTML = '<span style="color:var(--muted)">Loading...</span>';

  try {
    const snap = await getDocs(collection(db, 'eloading'));
    const txs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(t => t.date >= filterStart && t.date <= filterEnd)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderEloadSummary(txs);
    renderEloadHistory(txs, filterStart, filterEnd);
  } catch (err) {
    console.error('eLoading load failed', err);
    if (historyEl) historyEl.innerHTML = '<span style="color:var(--danger)">Failed to load. Check console.</span>';
  }
}

function renderEloadSummary(txs) {
  const totals = { 'gcash-cashin': { amount:0, fee:0 }, 'gcash-cashout': { amount:0, fee:0 }, 'maya-cashin': { amount:0, fee:0 }, 'maya-cashout': { amount:0, fee:0 }, 'bank-cashin': { amount:0, fee:0 }, 'bank-cashout': { amount:0, fee:0 }, 'wifi-load': { amount:0, fee:0 }, 'data-load': { amount:0, fee:0 } };
  txs.forEach(t => {
    if (totals[t.type]) {
      totals[t.type].amount += Number(t.amount || 0);
      totals[t.type].fee    += Number(t.fee || 0);
    }
  });
  Object.keys(totals).forEach(type => {
    const valEl = document.getElementById('eload-val-' + type);
    const feeEl = document.getElementById('eload-fee-' + type);
    if (valEl) valEl.textContent = formatCurrency(totals[type].amount);
    if (feeEl) feeEl.textContent = formatCurrency(totals[type].fee) + ' commission';
  });
  const totalFee = Object.values(totals).reduce((s,t) => s + t.fee, 0);
  const totalEl = document.getElementById('eload-total-commission');
  if (totalEl) totalEl.textContent = formatCurrency(totalFee);
}

function renderEloadHistory(txs, filterStart, filterEnd) {
  const historyEl = document.getElementById('eload-history');
  const countEl = document.getElementById('eload-tx-count');
  if (!historyEl) return;
  if (countEl) countEl.textContent = txs.length + ' transaction' + (txs.length !== 1 ? 's' : '');
  if (txs.length === 0) {
    historyEl.innerHTML = '<div style="color:var(--muted);padding:8px 0">No transactions on ' + formatDateRangeLabel(filterStart, filterEnd) + '</div>';
    return;
  }
  historyEl.innerHTML = '';
  txs.forEach(tx => {
    const typeInfo = ELOAD_TYPES[tx.type] || { label: tx.type, color: '#888' };
    const ts = tx.createdAt ? new Date(tx.createdAt.seconds * 1000) : null;
    const timeStr = ts ? ts.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
    const row = document.createElement('div');
    row.className = 'eload-tx-row';
    row.style.cursor = 'pointer';
    var customerStr = tx.customer ? ' — ' + tx.customer : '';
    var refStr = tx.refNum ? ' #' + tx.refNum : '';
    var metaStr = (tx.cashierName || '') + (timeStr ? ' · ' + timeStr : '') + refStr;

    // Type dot
    var dot = document.createElement('div');
    dot.className = 'eload-tx-type-dot';
    dot.style.background = typeInfo.color;
    row.appendChild(dot);

    // Body
    var body = document.createElement('div');
    body.className = 'eload-tx-body';
    var titleDiv = document.createElement('div');
    titleDiv.className = 'eload-tx-title';
    var strong = document.createElement('strong');
    strong.textContent = typeInfo.label;
    titleDiv.appendChild(strong);
    if (tx.customer) {
      var custSpan = document.createTextNode(' — ' + tx.customer);
      titleDiv.appendChild(custSpan);
    }
    body.appendChild(titleDiv);
    var metaDiv = document.createElement('div');
    metaDiv.className = 'eload-tx-meta';
    var metaParts = [];
    if (tx.cashierName) metaParts.push(tx.cashierName);
    if (timeStr) metaParts.push(timeStr);
    if (tx.refNum) metaParts.push('#' + tx.refNum);
    metaDiv.textContent = metaParts.join(' · ');
    body.appendChild(metaDiv);
    row.appendChild(body);

    // Amounts
    var amountsDiv = document.createElement('div');
    amountsDiv.className = 'eload-tx-amounts';
    var amtSpan = document.createElement('span');
    amtSpan.className = 'eload-tx-amount';
    amtSpan.textContent = formatCurrency(tx.amount);
    amountsDiv.appendChild(amtSpan);
    var feeSpan = document.createElement('span');
    feeSpan.className = 'eload-tx-fee';
    feeSpan.textContent = '+' + formatCurrency(tx.fee);
    amountsDiv.appendChild(feeSpan);
    row.appendChild(amountsDiv);

    // Delete button
    var delBtn = document.createElement('button');
    delBtn.className = 'remove-btn eload-del-btn';
    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.title = 'Delete this transaction';
    delBtn.onclick = function(e) {
      e.stopPropagation();
      deleteEloadTransaction(tx.id);
    };
    row.appendChild(delBtn);

    // Click row to show detail
    row.onclick = function() { showEloadDetail(tx); };

    historyEl.appendChild(row);
  });
}

function showEloadDetail(tx) {
  const modal = document.getElementById('eload-detail-modal');
  const titleEl = document.getElementById('eload-detail-title');
  const bodyEl = document.getElementById('eload-detail-body');
  const delBtn = document.getElementById('eload-detail-delete-btn');
  if (!modal) return;

  const typeInfo = ELOAD_TYPES[tx.type] || { label: tx.type, color: '#888' };
  const ts = tx.createdAt ? new Date(tx.createdAt.seconds * 1000) : null;
  const dateTimeStr = ts ? ts.toLocaleDateString() + ' ' + ts.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : tx.date || '';

  if (titleEl) titleEl.textContent = typeInfo.label + ' — Detail';

  var rows = [
    { label: 'Service',     value: typeInfo.label },
    { label: 'Amount',      value: formatCurrency(tx.amount) },
    { label: 'Commission',  value: formatCurrency(tx.fee) },
    { label: 'Mobile No.',  value: tx.mobile   || '—' },
    { label: 'Customer',    value: tx.customer || '—' },
    { label: 'Ref. No.',    value: tx.refNum   || '—' },
    { label: 'Cashier',     value: tx.cashierName || '—' },
    { label: 'Date & Time', value: dateTimeStr },
  ];

  if (bodyEl) {
    bodyEl.innerHTML = '';
    rows.forEach(function(r) {
      var line = document.createElement('div');
      line.className = 'eload-detail-row';
      var labelSpan = document.createElement('span');
      labelSpan.className = 'eload-detail-label';
      labelSpan.textContent = r.label;
      var valSpan = document.createElement('span');
      valSpan.className = 'eload-detail-val';
      valSpan.textContent = r.value;
      line.appendChild(labelSpan);
      line.appendChild(valSpan);
      bodyEl.appendChild(line);
    });
  }

  if (delBtn) {
    delBtn.onclick = function() {
      closeEloadDetail();
      deleteEloadTransaction(tx.id);
    };
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeEloadDetail() {
  var modal = document.getElementById('eload-detail-modal');
  if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
}

async function deleteEloadTransaction(id) {
  if (!id) return;
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  try {
    await deleteDoc(doc(db, 'eloading', id));
    playSfx('delete');
    loadEloadTransactions();
  } catch (err) {
    console.error('eLoading delete failed', err);
    alert('Failed to delete. Try again.');
  }
}

window.closeEloadDetail = closeEloadDetail;

async function saveEloadTransaction() {
  if (_eloadSaving) return;
  const amountEl  = document.getElementById('eload-amount');
  const feeEl     = document.getElementById('eload-fee');
  const customerEl = document.getElementById('eload-customer');
  const mobileEl  = document.getElementById('eload-mobile');
  const saveBtn   = document.getElementById('eload-save-btn');

  const amount = Number(amountEl?.value || 0);
  const fee    = Number(feeEl?.value || 0);
  const customer = (customerEl?.value || '').trim();
  const mobile   = (mobileEl?.value || '').trim();

  if (amount <= 0) { showErrorModal('Please enter the amount.'); return; }
  if (fee < 0)     { showErrorModal('Fee cannot be negative.'); return; }

  if (currentUserRole === 'cashier') {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
      return alert('You must start a shift before recording eLoading.');
    }
  }

  _eloadSaving = true;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  try {
    const refNumEl = document.getElementById('eload-refnum');
    const refNum = (refNumEl?.value || '').trim();
    await addDoc(collection(db, 'eloading'), {
      type: _eloadSelectedType,
      amount: Number(amount.toFixed(2)),
      fee: Number(fee.toFixed(2)),
      customer: customer,
      mobile: mobile,
      refNum: refNum,
      cashierName: currentEmployeeName || currentUsername || '',
      shiftId: currentShift?.id || '',
      date: eloadTodayStr(),
      createdAt: serverTimestamp()
    });

    // Reset form
    if (amountEl)   amountEl.value = '';
    if (feeEl)      feeEl.value = '';
    if (customerEl) customerEl.value = '';
    if (mobileEl)   mobileEl.value = '';
    if (refNumEl)   refNumEl.value = '';

    playSfx('add');
    loadEloadTransactions();
  } catch (err) {
    console.error('eLoading save failed', err);
    alert('Failed to save. Please try again.');
  } finally {
    _eloadSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Record Transaction'; }
  }
}

window.loadEloadingPage = loadEloadingPage;
// ═══════════════════════════════════════════════════════════
// ICE SALES PAGE
// ═══════════════════════════════════════════════════════════
let _iceSaving = false;

function iceTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function _updateIceFormTotal() {
  const price = Number(document.getElementById('ice-price')?.value || 0);
  const qty   = Number(document.getElementById('ice-qty')?.value   || 0);
  const totalEl = document.getElementById('ice-form-total');
  if (totalEl) totalEl.textContent = formatCurrency(price * qty);
}

async function loadIcePage() {
  const startInput = document.getElementById('ice-filter-start-date');
  const endInput = document.getElementById('ice-filter-end-date');
  if (startInput && !startInput.value) startInput.value = iceTodayStr();
  if (endInput && !endInput.value) endInput.value = iceTodayStr();
  if (startInput) startInput.onchange = loadIceTransactions;
  if (endInput) endInput.onchange = loadIceTransactions;

  const dailyBtn = document.getElementById('ice-daily-btn');
  if (dailyBtn) dailyBtn.onclick = () => {
    const d = iceTodayStr();
    if (startInput) startInput.value = d;
    if (endInput) endInput.value = d;
    loadIceTransactions();
  };
  const weeklyBtn = document.getElementById('ice-weekly-btn');
  if (weeklyBtn) weeklyBtn.onclick = () => {
    const range = getWeekRangeStr();
    if (startInput) startInput.value = range.start;
    if (endInput) endInput.value = range.end;
    loadIceTransactions();
  };
  const monthlyBtn = document.getElementById('ice-monthly-btn');
  if (monthlyBtn) monthlyBtn.onclick = () => {
    const range = getMonthRangeStr();
    if (startInput) startInput.value = range.start;
    if (endInput) endInput.value = range.end;
    loadIceTransactions();
  };

  // Live total preview
  document.getElementById('ice-price')?.addEventListener('input', _updateIceFormTotal);
  document.getElementById('ice-qty')?.addEventListener('input',   _updateIceFormTotal);

  const saveBtn = document.getElementById('ice-save-btn');
  if (saveBtn) saveBtn.onclick = saveIceSale;

  loadIceTransactions();
}

async function loadIceTransactions() {
  const startInput = document.getElementById('ice-filter-start-date');
  const endInput = document.getElementById('ice-filter-end-date');
  const filterStart = (startInput && startInput.value) ? startInput.value : iceTodayStr();
  const filterEnd = (endInput && endInput.value) ? endInput.value : iceTodayStr();
  const historyEl = document.getElementById('ice-history');
  if (historyEl) historyEl.innerHTML = '<span style="color:var(--muted)">Loading...</span>';

  try {
    const snap = await getDocs(collection(db, 'icesales'));
    const txs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(t => t.date >= filterStart && t.date <= filterEnd)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderIceSummary(txs);
    renderIceHistory(txs, filterStart, filterEnd);
  } catch (err) {
    console.error('Ice sales load failed', err);
    if (historyEl) historyEl.innerHTML = '<span style="color:var(--danger)">Failed to load.</span>';
  }
}

function renderIceSummary(txs) {
  let totalIncome = 0, totalQty = 0;
  txs.forEach(t => {
    totalIncome += Number(t.total || 0);
    totalQty    += Number(t.quantity || 0);
  });
  const incEl  = document.getElementById('ice-total-income');
  const qtyEl  = document.getElementById('ice-total-qty');
  const cntEl  = document.getElementById('ice-tx-count');
  if (incEl)  incEl.textContent  = formatCurrency(totalIncome);
  if (qtyEl)  qtyEl.textContent  = totalQty;
  if (cntEl)  cntEl.textContent  = txs.length;
}

function renderIceHistory(txs, filterStart, filterEnd) {
  const historyEl = document.getElementById('ice-history');
  if (!historyEl) return;
  if (txs.length === 0) {
    historyEl.innerHTML = '<div style="color:var(--muted);padding:8px 0">No ice sales on ' + formatDateRangeLabel(filterStart, filterEnd) + '</div>';
    return;
  }
  historyEl.innerHTML = '';
  txs.forEach(tx => {
    const ts = tx.createdAt ? new Date(tx.createdAt.seconds * 1000) : null;
    const timeStr = ts ? ts.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';

    const row = document.createElement('div');
    row.className = 'ice-tx-row';

    // Left: icon + info
    var dot = document.createElement('div');
    dot.className = 'ice-tx-dot';
    row.appendChild(dot);

    var body = document.createElement('div');
    body.className = 'ice-tx-body';

    var title = document.createElement('div');
    title.className = 'ice-tx-title';
    title.textContent = tx.quantity + ' bag' + (tx.quantity !== 1 ? 's' : '') + ' @ ' + formatCurrency(tx.price) + ' each';
    body.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'ice-tx-meta';
    var metaParts = [];
    if (tx.cashierName) metaParts.push(tx.cashierName);
    if (timeStr) metaParts.push(timeStr);
    meta.textContent = metaParts.join(' · ');
    body.appendChild(meta);
    row.appendChild(body);

    // Right: total
    var totalSpan = document.createElement('span');
    totalSpan.className = 'ice-tx-total';
    totalSpan.textContent = formatCurrency(tx.total);
    row.appendChild(totalSpan);

    // Delete button
    var delBtn = document.createElement('button');
    delBtn.className = 'remove-btn eload-del-btn';
    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.title = 'Delete this sale';
    delBtn.onclick = function(e) {
      e.stopPropagation();
      deleteIceSale(tx.id);
    };
    row.appendChild(delBtn);

    historyEl.appendChild(row);
  });
}

async function saveIceSale() {
  if (_iceSaving) return;
  const priceEl = document.getElementById('ice-price');
  const qtyEl   = document.getElementById('ice-qty');
  const price = Number(priceEl?.value || 0);
  const qty   = Number(qtyEl?.value   || 0);

  if (price <= 0) { showErrorModal('Please enter a price per bag.'); return; }
  if (qty <= 0)   { showErrorModal('Please enter a quantity.'); return; }

  if (currentUserRole === 'cashier') {
    if (!currentShift || !currentShift.id || currentShift.status !== 'open') {
      return alert('You must start a shift before recording ice sales.');
    }
  }

  _iceSaving = true;
  const saveBtn = document.getElementById('ice-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  try {
    await addDoc(collection(db, 'icesales'), {
      price: Number(price.toFixed(2)),
      quantity: Number(qty),
      total: Number((price * qty).toFixed(2)),
      cashierName: currentEmployeeName || currentUsername || '',
      shiftId: currentShift?.id || '',
      date: iceTodayStr(),
      createdAt: serverTimestamp()
    });
    if (priceEl) priceEl.value = '';
    if (qtyEl)   qtyEl.value   = '';
    const totalEl = document.getElementById('ice-form-total');
    if (totalEl) totalEl.textContent = 'PHP 0.00';
    playSfx('add');
    loadIceTransactions();
  } catch (err) {
    console.error('Ice sale save failed', err);
    alert('Failed to save. Please try again.');
  } finally {
    _iceSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Record Sale'; }
  }
}

async function deleteIceSale(id) {
  if (!id) return;
  if (!confirm('Delete this ice sale? This cannot be undone.')) return;
  try {
    await deleteDoc(doc(db, 'icesales', id));
    playSfx('delete');
    loadIceTransactions();
  } catch (err) {
    console.error('Ice sale delete failed', err);
    alert('Failed to delete. Try again.');
  }
}

window.loadIcePage = loadIcePage;

