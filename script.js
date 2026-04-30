// ===================================
// 🔐 AUTH CHECK
// ===================================

if (localStorage.getItem("isLoggedIn") !== "true") {
  window.location.replace("Form.html");
}

// ===================================
// ⚙️ CONFIG
// ===================================

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHKe7HT-iKoM3sXoqa8ZWjNuBC1c1Ms6HZfhx6ERNsPpCR7X7Ap7DTEMLkgb3LT54jDg/exec";

const SHEETS = {
  atProducts:   "A&T - Current Stock",
  averProducts: "Aver - Current Stock",
  atDemo:       "A&T - Demo Stock",
  averDemo:     "Aver - Demo Stock"
};

// ===================================
// GLOBAL STATE
// ===================================

let allowNavigation  = false;
let sidebarCollapsed = false;
let currentView      = "";
let searchQuery      = "";

const cachedData = {
  atProducts:   null,
  averProducts: null,
  atDemo:       null,
  averDemo:     null
};

// Popup data store — survives DOM redraws
let popupStore = [];
function storeForPopup(data) { popupStore.push(data); return popupStore.length - 1; }
function clearPopupStore()   { popupStore = []; }

// ===================================
// ██ POPUP NAVIGATION STACK ██████████
//
//  showPopup(html)  — opens a fresh popup at Level 0; resets stack
//  pushPopup(html)  — saves current content → shows new content (Level N+1)
//  popupBack()      — restores previous level from stack  (Level N-1)
//  closePopup()     — hides overlay, clears stack
//
//  Hardware back key:
//    stack has entries  → popupBack()
//    stack is empty     → closePopup()
//    no popup open      → double-back-to-exit
// ===================================

let popupStack = [];

// ===================================
// ── BACK BUTTON: Exit confirmation ──
// ===================================

let backPressedOnce = false;
let backPressTimer  = null;

function handleHardwareBack() {
  // 1. If a popup is visible, navigate within it first
  const overlay = document.getElementById("inventoryPopup");
  if (overlay && overlay.classList.contains("active")) {
    if (popupStack.length > 0) {
      popupBack();    // go one level up inside the popup
    } else {
      closePopup();   // stack empty — close popup entirely
    }
    return;
  }

  // 2. No popup open — double-back to exit
  if (backPressedOnce) {
    clearTimeout(backPressTimer);
    if (window.Android && typeof window.Android.exitApp === "function") {
      window.Android.exitApp();
    } else {
      history.go(-1);
    }
    return;
  }

  backPressedOnce = true;
  showExitToast("Press back again to exit");
  backPressTimer = setTimeout(() => { backPressedOnce = false; }, 2000);

  window.history.pushState(null, null, window.location.href);
}

function showExitToast(msg) {
  let toast = document.getElementById("exitToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "exitToast";
    toast.style.cssText = `
      position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
      background: rgba(30,30,30,0.88); color: #fff; padding: 10px 22px;
      border-radius: 24px; font-size: 14px; z-index: 99999;
      pointer-events: none; opacity: 0; transition: opacity 0.25s;
      white-space: nowrap;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = "0"; }, 1800);
}

// ===================================
// ██ REAL-TIME SYNC ENGINE ████████████
// ===================================

const SyncEngine = (() => {
  const SYNC_INTERVAL_MS = 2000;
  const SHEET_KEYS       = ["atProducts", "averProducts", "atDemo", "averDemo"];

  let rafHandle     = null;
  let syncActive    = false;
  let isPageVisible = !document.hidden;

  const lastFetchTime = {
    atProducts:   0,
    averProducts: 0,
    atDemo:       0,
    averDemo:     0
  };

  const STAGGER_OFFSETS = {
    atProducts:   0,
    averProducts: 500,
    atDemo:       1000,
    averDemo:     1500
  };

  const fingerprints = {
    atProducts:   "",
    averProducts: "",
    atDemo:       "",
    averDemo:     ""
  };

  function fingerprint(data) {
    if (!data || !Array.isArray(data)) return "";
    return data.map((row, i) => {
      const vals = Object.values(row).join("|");
      return `${i}:${vals.length}:${vals.slice(0, 40)}`;
    }).join("||");
  }

  function showSyncDot(state) {
    let dot = document.getElementById("syncStatusDot");
    if (!dot) {
      dot = document.createElement("div");
      dot.id = "syncStatusDot";
      dot.style.cssText = `
        position: fixed; bottom: 18px; right: 18px; width: 10px; height: 10px;
        border-radius: 50%; z-index: 9999; transition: background 0.3s, box-shadow 0.3s;
        pointer-events: none;
      `;
      document.body.appendChild(dot);
    }
    if (state === "syncing") {
      dot.style.background = "#f59e0b";
      dot.style.boxShadow  = "0 0 0 3px rgba(245,158,11,0.3)";
    } else if (state === "updated") {
      dot.style.background = "#10b981";
      dot.style.boxShadow  = "0 0 0 3px rgba(16,185,129,0.3)";
      setTimeout(() => showSyncDot("idle"), 1200);
    } else {
      dot.style.background = "rgba(150,150,150,0.4)";
      dot.style.boxShadow  = "none";
    }
  }

  async function maybeSyncSheet(key, nowMs) {
    const due = lastFetchTime[key] + SYNC_INTERVAL_MS + STAGGER_OFFSETS[key];
    if (nowMs < due) return false;

    lastFetchTime[key] = nowMs;
    const sheetName = SHEETS[key];
    let freshData;
    try {
      const res = await fetch(`${SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}&_t=${nowMs}`);
      freshData = await res.json();
      if (freshData.error) throw new Error(freshData.error);
    } catch (e) {
      console.warn(`[Sync] Failed to fetch ${sheetName}:`, e);
      return false;
    }

    const newPrint = fingerprint(freshData);
    if (newPrint === fingerprints[key]) return false;

    fingerprints[key] = newPrint;
    cachedData[key]   = freshData;
    applyLiveUpdate(key, freshData);
    return true;
  }

  function applyLiveUpdate(key, freshData) {
    const viewMap = {
      atProducts:   "at-products",
      averProducts: "aver-products",
      atDemo:       "at-demo",
      averDemo:     "aver-demo"
    };
    const targetView = viewMap[key];
    showSyncDot("updated");
    if (currentView === targetView) {
      switch (key) {
        case "atProducts": {
          clearPopupStore();
          renderATSummaryCards(freshData);
          renderProductTable(freshData, "at-products-table-body", "at");
          if (searchQuery) applySearchFilter(searchQuery.toLowerCase());
          break;
        }
        case "averProducts": {
          clearPopupStore();
          renderAverSummaryCards(freshData);
          renderProductTable(freshData, "aver-products-table-body", "aver");
          if (searchQuery) applySearchFilter(searchQuery.toLowerCase());
          break;
        }
        case "atDemo": {
          clearPopupStore();
          const merged = mergeDemoRows(freshData);
          renderDemoSummaryCards(merged, "at-demo-summary");
          renderDemoTable(merged, "at-demo-table-body");
          if (searchQuery) applySearchFilter(searchQuery.toLowerCase());
          break;
        }
        case "averDemo": {
          clearPopupStore();
          const merged = mergeDemoRows(freshData);
          renderDemoSummaryCards(merged, "aver-demo-summary");
          renderDemoTable(merged, "aver-demo-table-body");
          if (searchQuery) applySearchFilter(searchQuery.toLowerCase());
          break;
        }
      }
    }
  }

  function rafLoop() {
    if (!syncActive) return;
    if (!isPageVisible) { rafHandle = requestAnimationFrame(rafLoop); return; }
    const nowMs = Date.now();
    SHEET_KEYS.forEach(key => {
      maybeSyncSheet(key, nowMs).then(changed => { if (changed) showSyncDot("updated"); });
    });
    rafHandle = requestAnimationFrame(rafLoop);
  }

  function onVisibilityChange() {
    isPageVisible = !document.hidden;
    if (isPageVisible) { SHEET_KEYS.forEach(key => { lastFetchTime[key] = 0; }); }
  }

  function start() {
    if (syncActive) return;
    syncActive = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
    rafHandle  = requestAnimationFrame(rafLoop);
    showSyncDot("idle");
  }

  function stop() {
    syncActive = false;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function invalidate(key)  { fingerprints[key] = ""; lastFetchTime[key] = 0; }
  function invalidateAll()  { SHEET_KEYS.forEach(k => invalidate(k)); }

  return { start, stop, invalidate, invalidateAll };
})();

// ===================================
// DOM ELEMENTS
// ===================================

const dashboardSidebar        = document.getElementById("dashboardSidebar");
const userMenu                = document.getElementById("userMenu");
const userMenuTrigger         = document.getElementById("user-menu-trigger");
const themeToggle             = document.getElementById("theme-toggle");
const dashboardTitle          = document.getElementById("dashboardTitle");
const dashboardSidebarOverlay = document.getElementById("dashboardSidebarOverlay");

const searchInput         = document.getElementById("searchInput");
const searchClear         = document.getElementById("searchClear");
const mobileSearchBtn     = document.getElementById("mobileSearchBtn");
const mobileSearchBar     = document.getElementById("mobileSearchBar");
const mobileSearchInput   = document.getElementById("mobileSearchInput");
const mobileSearchClose   = document.getElementById("mobileSearchClose");
const searchResultsBanner = document.getElementById("searchResultsBanner");
const searchResultsText   = document.getElementById("searchResultsText");
const clearSearchBtn      = document.getElementById("clearSearchBtn");

const logoutModal      = document.getElementById("logoutModal");
const confirmLogoutBtn = document.getElementById("confirmLogout");
const cancelLogoutBtn  = document.getElementById("cancelLogout");
const logoutBtnSidebar = document.getElementById("logoutBtnSidebar");
const logoutBtnHeader  = document.getElementById("logoutBtnHeader");

// ===================================
// INITIALIZATION
// ===================================

document.addEventListener("DOMContentLoaded", function () {
  initTheme();
  initThemeToggle();
  initSidebar();
  initUserMenu();
  initNavigation();
  initSearch();
  initLogout();
  initBackControl();
  loadView("at-products");
  setTimeout(() => SyncEngine.start(), 2500);
});

// ===================================
// BACK BUTTON CONTROL
// ===================================

function initBackControl() {
  window.history.pushState(null, null, window.location.href);

  window.addEventListener("popstate", function () {
    window.history.pushState(null, null, window.location.href);
    handleHardwareBack();
  });

  window.addEventListener("beforeunload", function (e) {
    if (!allowNavigation) { e.preventDefault(); e.returnValue = ""; }
  });
}

// ===================================
// SIDEBAR
// ===================================

function initSidebar() {
  sidebarCollapsed = localStorage.getItem("dashboard-sidebar-collapsed") === "true";
  if (window.innerWidth > 1024) {
    dashboardSidebar.classList.toggle("collapsed", sidebarCollapsed);
  }
  document.querySelectorAll(".dashboard-sidebar-toggle").forEach((toggle) => {
    toggle.addEventListener("click", toggleSidebar);
  });
  dashboardSidebarOverlay?.addEventListener("click", closeSidebar);
}

function toggleSidebar() {
  const isMobile = window.innerWidth <= 1024;
  if (isMobile) {
    const isOpen = dashboardSidebar.classList.contains("collapsed");
    dashboardSidebar.classList.toggle("collapsed", !isOpen);
    dashboardSidebarOverlay?.classList.toggle("active", !isOpen);
  } else {
    sidebarCollapsed = !sidebarCollapsed;
    dashboardSidebar.classList.toggle("collapsed", sidebarCollapsed);
    localStorage.setItem("dashboard-sidebar-collapsed", sidebarCollapsed.toString());
  }
}

function closeSidebar() {
  if (window.innerWidth <= 1024) {
    dashboardSidebar.classList.remove("collapsed");
    dashboardSidebarOverlay?.classList.remove("active");
  }
}

// ===================================
// USER MENU
// ===================================

function initUserMenu() {
  if (!userMenuTrigger || !userMenu) return;
  userMenuTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    userMenu.classList.toggle("active");
  });
  document.addEventListener("click", (e) => {
    if (!userMenu.contains(e.target)) userMenu.classList.remove("active");
  });
}

// ===================================
// NAVIGATION
// ===================================

const VIEW_TITLES = {
  "at-products":   "A&T Products",
  "aver-products": "Aver Products",
  "at-demo":       "A&T Demo Stock",
  "aver-demo":     "Aver Demo Stock"
};

function initNavigation() {
  document.querySelectorAll(".dashboard-nav-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const viewId = item.getAttribute("data-view");
      if (viewId) {
        document.querySelectorAll(".dashboard-nav-item").forEach((i) => i.classList.remove("active"));
        item.classList.add("active");
        loadView(viewId);
      }
    });
  });
}

function loadView(viewId) {
  currentView = viewId;
  clearSearch(false);
  if (dashboardTitle) dashboardTitle.textContent = VIEW_TITLES[viewId] || viewId;

  document.querySelectorAll(".dashboard-view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");

  const content = document.querySelector(".dashboard-content");
  if (content) content.scrollTop = 0;

  switch (viewId) {
    case "at-products":   loadATProducts();   break;
    case "aver-products": loadAverProducts(); break;
    case "at-demo":       loadATDemo();       break;
    case "aver-demo":     loadAverDemo();     break;
  }

  if (window.innerWidth <= 1024) closeSidebar();
}

// ===================================
// DATA FETCHING
// ===================================

async function fetchSheetData(sheetName) {
  try {
    const response = await fetch(`${SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}`);
    const data     = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (err) {
    console.error(`Error fetching "${sheetName}":`, err);
    return null;
  }
}

// ===================================
// LOADING / ERROR STATES
// ===================================

function showLoading(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p>Loading data...</p></div>`;
}

function showError(containerId, message) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="error-state">
      <span class="material-symbols-rounded">error_outline</span>
      <p>${message}</p>
      <button class="btn btn-primary" onclick="loadView('${currentView}')">Retry</button>
    </div>`;
}

// ===================================
// SEARCH
// ===================================

function initSearch() {
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    if (mobileSearchInput) mobileSearchInput.value = searchQuery;
    handleSearch();
  });
  searchClear?.addEventListener("click", () => clearSearch(true));

  mobileSearchBtn?.addEventListener("click", () => {
    mobileSearchBar.classList.add("open");
    mobileSearchInput?.focus();
  });
  mobileSearchClose?.addEventListener("click", () => {
    mobileSearchBar.classList.remove("open");
    clearSearch(true);
  });
  mobileSearchInput?.addEventListener("input", () => {
    searchQuery = mobileSearchInput.value.trim();
    if (searchInput) searchInput.value = searchQuery;
    handleSearch();
  });
  clearSearchBtn?.addEventListener("click", () => clearSearch(true));
}

function handleSearch() {
  const q = searchQuery.toLowerCase();
  if (searchClear) searchClear.classList.toggle("visible", q.length > 0);
  if (searchResultsBanner && searchResultsText) {
    if (q.length > 0) {
      searchResultsBanner.style.display = "flex";
      searchResultsText.textContent = `Filtering results for "${searchQuery}"`;
    } else {
      searchResultsBanner.style.display = "none";
    }
  }
  applySearchFilter(q);
}

function clearSearch(focusInput = false) {
  searchQuery = "";
  if (searchInput) searchInput.value = "";
  if (mobileSearchInput) mobileSearchInput.value = "";
  if (searchClear) searchClear.classList.remove("visible");
  if (searchResultsBanner) searchResultsBanner.style.display = "none";
  applySearchFilter("");
  if (focusInput && searchInput) searchInput.focus();
}

function applySearchFilter(q) {
  switch (currentView) {
    case "at-products":   filterView(q, "at-products-table-body",   "at-products-no-results");   break;
    case "aver-products": filterView(q, "aver-products-table-body", "aver-products-no-results"); break;
    case "at-demo":       filterView(q, "at-demo-table-body",       "at-demo-no-results");       break;
    case "aver-demo":     filterView(q, "aver-demo-table-body",     "aver-demo-no-results");     break;
  }
}

function filterView(q, tableBodyId, noResultsId) {
  const tbody     = document.getElementById(tableBodyId);
  const noResults = document.getElementById(noResultsId);
  let rowVisible  = 0;

  if (tbody) {
    tbody.querySelectorAll("tr").forEach((row) => {
      const text = row.textContent.toLowerCase();
      const show = !q || text.includes(q);
      row.classList.toggle("hidden", !show);
      if (show) rowVisible++;
    });
  }
  if (noResults) noResults.style.display = (q && rowVisible === 0) ? "flex" : "none";
}

// ===================================
// UTILITY
// ===================================

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildAllFieldsTable(row, skipKeys = []) {
  const skip = new Set(["Product Model", "PRODUCT MODEL", "__rawRows", ...skipKeys]);
  const rows = Object.entries(row)
    .filter(([key, val]) => !skip.has(key) && val !== "" && val !== null && val !== undefined)
    .map(([key, val]) => `
      <tr>
        <td class="detail-label">${escHtml(key)}</td>
        <td class="detail-value">${escHtml(String(val))}</td>
      </tr>`)
    .join("");

  if (!rows) return '<p class="no-data">No additional data available.</p>';
  return `<table class="detail-table"><tbody>${rows}</tbody></table>`;
}

// ===================================
// ██ POPUP NAVIGATION SYSTEM █████████
// ===================================

function getOrCreateOverlay() {
  let overlay = document.getElementById("inventoryPopup");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id        = "inventoryPopup";
    overlay.className = "inventory-popup-overlay";
    document.body.appendChild(overlay);
    // Tap outside the box to close entirely
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePopup(); });
    // Escape key (desktop / physical keyboard)
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });
  }
  return overlay;
}

/** Open a brand-new popup at Level 0. Always resets the stack. */
function showPopup(innerHtml) {
  popupStack = [];
  const overlay = getOrCreateOverlay();
  overlay.innerHTML = `<div class="inventory-popup-box">${innerHtml}</div>`;
  overlay.classList.add("active");
}

/** Push current popup content onto the stack and show new content (Level N+1). */
function pushPopup(innerHtml) {
  const overlay = getOrCreateOverlay();
  const box     = overlay.querySelector(".inventory-popup-box");
  if (box) {
    popupStack.push(box.innerHTML);
    box.innerHTML = innerHtml;
  } else {
    showPopup(innerHtml);
  }
}

/** Restore the previous popup level from the stack. */
function popupBack() {
  if (popupStack.length === 0) { closePopup(); return; }
  const prev    = popupStack.pop();
  const overlay = document.getElementById("inventoryPopup");
  const box     = overlay?.querySelector(".inventory-popup-box");
  if (box) box.innerHTML = prev;
}

/** Close popup and clear stack. */
function closePopup() {
  popupStack = [];
  const overlay = document.getElementById("inventoryPopup");
  if (overlay) overlay.classList.remove("active");
}

/** Shared back-button bar rendered inside pushed popup levels. */
function popupNavBar(label) {
  return `
    <div class="popup-nav">
      <button class="popup-back-btn" onclick="popupBack()">
        <span class="material-symbols-rounded">arrow_back_ios_new</span>
        ${escHtml(label)}
      </button>
    </div>`;
}

// ===================================
// ── A&T PRODUCTS ──
// ===================================

async function loadATProducts() {
  showLoading("at-products-summary");
  showLoading("at-products-table-body");

  if (!cachedData.atProducts) {
    cachedData.atProducts = await fetchSheetData(SHEETS.atProducts);
  }

  const data = cachedData.atProducts;
  if (!data) { showError("at-products-summary", "Failed to load A&T Products."); return; }

  clearPopupStore();
  renderATSummaryCards(data);
  renderProductTable(data, "at-products-table-body", "at");
}

function renderATSummaryCards(data) {
  const container = document.getElementById("at-products-summary");
  if (!container) return;

  const categories   = [...new Set(data.map(r => r["Category"]).filter(Boolean))];
  const totalHO      = data.reduce((s, r) => s + (Number(r["Stock at HO"])   || 0), 0);
  const totalMFG     = data.reduce((s, r) => s + (Number(r["Stock at MFG"])  || 0), 0);
  const totalSalable = data.reduce((s, r) => s + (Number(r["Salable Stock"]) || 0), 0);

  const catIdx  = storeForPopup({ __catList: true, viewType: "at", categories });
  const prodIdx = storeForPopup({ __allProds: true, viewType: "at", data });

  const hoProducts  = data.filter(r => (Number(r["Stock at HO"])  || 0) > 0);
  const mfgProducts = data.filter(r => (Number(r["Stock at MFG"]) || 0) > 0);
  const hoIdx  = storeForPopup({ __stockFilter: true, viewType: "at", products: hoProducts,  label: "Stock at HO",  field: "Stock at HO"  });
  const mfgIdx = storeForPopup({ __stockFilter: true, viewType: "at", products: mfgProducts, label: "Stock at MFG", field: "Stock at MFG" });

  container.innerHTML = `
    <div class="summary-card purple clickable-summary-card" onclick="openCategoryListPopup(${catIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">category</span></div>
      <div class="summary-card-label">Categories</div>
      <div class="summary-card-value">${categories.length}</div>
      <div class="summary-card-sub">Tap to browse</div>
    </div>
    <div class="summary-card blue clickable-summary-card" onclick="openAllProductsPopup(${prodIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">inventory_2</span></div>
      <div class="summary-card-label">Product Models</div>
      <div class="summary-card-value">${data.length}</div>
      <div class="summary-card-sub">Tap to browse</div>
    </div>
    <div class="summary-card orange clickable-summary-card" onclick="openStockFilterPopup(${hoIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">warehouse</span></div>
      <div class="summary-card-label">Stock at HO</div>
      <div class="summary-card-value">${totalHO}</div>
      <div class="summary-card-sub">Head office</div>
    </div>
    <div class="summary-card green clickable-summary-card" onclick="openStockFilterPopup(${mfgIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">factory</span></div>
      <div class="summary-card-label">Stock at MFG</div>
      <div class="summary-card-value">${totalMFG}</div>
      <div class="summary-card-sub">Manufacturing</div>
    </div>
    <div class="summary-card purple">
      <div class="summary-card-icon"><span class="material-symbols-rounded">sell</span></div>
      <div class="summary-card-label">Salable Stock</div>
      <div class="summary-card-value">${totalSalable}</div>
      <div class="summary-card-sub">Ready to sell</div>
    </div>`;
}

// ===================================
// ── AVER PRODUCTS ──
// ===================================

async function loadAverProducts() {
  showLoading("aver-products-summary");
  showLoading("aver-products-table-body");

  if (!cachedData.averProducts) {
    cachedData.averProducts = await fetchSheetData(SHEETS.averProducts);
  }

  const data = cachedData.averProducts;
  if (!data) { showError("aver-products-summary", "Failed to load Aver Products."); return; }

  clearPopupStore();
  renderAverSummaryCards(data);
  renderProductTable(data, "aver-products-table-body", "aver");
}

function renderAverSummaryCards(data) {
  const container = document.getElementById("aver-products-summary");
  if (!container) return;

  const categories    = [...new Set(data.map(r => r["Category"]).filter(Boolean))];
  const totalSalable  = data.reduce((s, r) => s + (Number(r["Salable Stock"])  || 0), 0);
  const totalReserved = data.reduce((s, r) => s + (Number(r["Reserved Stock"]) || 0), 0);

  const catIdx  = storeForPopup({ __catList: true, viewType: "aver", categories });
  const prodIdx = storeForPopup({ __allProds: true, viewType: "aver", data });

  container.innerHTML = `
    <div class="summary-card purple clickable-summary-card" onclick="openCategoryListPopup(${catIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">category</span></div>
      <div class="summary-card-label">Categories</div>
      <div class="summary-card-value">${categories.length}</div>
      <div class="summary-card-sub">Tap to browse</div>
    </div>
    <div class="summary-card blue clickable-summary-card" onclick="openAllProductsPopup(${prodIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">inventory_2</span></div>
      <div class="summary-card-label">Product Models</div>
      <div class="summary-card-value">${data.length}</div>
      <div class="summary-card-sub">Tap to browse</div>
    </div>
    <div class="summary-card green">
      <div class="summary-card-icon"><span class="material-symbols-rounded">sell</span></div>
      <div class="summary-card-label">Salable Stock</div>
      <div class="summary-card-value">${totalSalable}</div>
      <div class="summary-card-sub">Ready to sell</div>
    </div>`;
}

// ===================================
// SHARED PRODUCT TABLE RENDERER
// ===================================

function renderProductTable(data, tbodyId, viewType) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">No data available.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((row) => {
    const idx      = storeForPopup({ type: viewType, row });
    const category = row["Category"]      || "";
    const model    = row["Product Model"] || "";
    const salable  = row["Salable Stock"] ?? "";
    const catIdx   = storeForPopup({ __catClick: true, viewType, selectedCategory: category });

    return `
      <tr>
        <td class="clickable-cell cat-cell" onclick="openCategoryClickPopup(${catIdx})">${escHtml(category)}</td>
        <td class="clickable-cell"          onclick="openProductDetailDirect(${idx})">${escHtml(model)}</td>
        <td>${salable}</td>
      </tr>`;
  }).join("");
}

// ===================================
// ── DEMO STOCK HELPERS ──
// ===================================

function mergeDemoRows(rawData) {
  const map = new Map();

  rawData.forEach((row) => {
    const model = String(row["Product Model"] || row["PRODUCT MODEL"] || "").trim();
    if (!model) return;

    const type  = String(row["Type"] || row["TYPE"] || "Demo").trim().toLowerCase();
    const total = Number(row["Total"] || row["TOTAL"] || 0);

    if (!map.has(model)) {
      const entry = { ...row };
      entry["Product Model"] = model;
      entry["Demo"]          = 0;
      entry["Support"]       = 0;
      entry["Total Stock"]   = 0;
      entry.__rawRows        = [];
      map.set(model, entry);
    }

    const entry = map.get(model);
    if (type === "demo")         entry["Demo"]    += total;
    else if (type === "support") entry["Support"] += total;
    else                         entry["Demo"]    += total;

    entry["Total Stock"] = entry["Demo"] + entry["Support"];
    entry.__rawRows.push(row);
  });

  return Array.from(map.values());
}

// ===================================
// ── A&T DEMO STOCK ──
// ===================================

async function loadATDemo() {
  showLoading("at-demo-summary");
  showLoading("at-demo-table-body");

  if (!cachedData.atDemo) {
    cachedData.atDemo = await fetchSheetData(SHEETS.atDemo);
  }

  const data = cachedData.atDemo;
  if (!data) { showError("at-demo-summary", "Failed to load A&T Demo Stock."); return; }

  clearPopupStore();
  const merged = mergeDemoRows(data);
  renderDemoSummaryCards(merged, "at-demo-summary");
  renderDemoTable(merged, "at-demo-table-body");
}

// ===================================
// ── AVER DEMO STOCK ──
// ===================================

async function loadAverDemo() {
  showLoading("aver-demo-summary");
  showLoading("aver-demo-table-body");

  if (!cachedData.averDemo) {
    cachedData.averDemo = await fetchSheetData(SHEETS.averDemo);
  }

  const data = cachedData.averDemo;
  if (!data) { showError("aver-demo-summary", "Failed to load Aver Demo Stock."); return; }

  clearPopupStore();
  const merged = mergeDemoRows(data);
  renderDemoSummaryCards(merged, "aver-demo-summary");
  renderDemoTable(merged, "aver-demo-table-body");
}

// ===================================
// DEMO SUMMARY CARDS
// ===================================

function renderDemoSummaryCards(data, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const totalDemo    = data.reduce((s, r) => s + (Number(r["Demo"])        || 0), 0);
  const totalSupport = data.reduce((s, r) => s + (Number(r["Support"])     || 0), 0);
  const totalAll     = data.reduce((s, r) => s + (Number(r["Total Stock"]) || 0), 0);

  const allDemoIdx = storeForPopup({ __allDemo: true, data });

  const demoOnlyProducts    = data.filter(r => (Number(r["Demo"])    || 0) > 0);
  const supportOnlyProducts = data.filter(r => (Number(r["Support"]) || 0) > 0);
  const demoFilterIdx    = storeForPopup({ __demoFilter: true, products: demoOnlyProducts,    label: "Demo Stock"    });
  const supportFilterIdx = storeForPopup({ __demoFilter: true, products: supportOnlyProducts, label: "Support Stock" });

  container.innerHTML = `
    <div class="summary-card blue clickable-summary-card" onclick="openAllDemoProductsPopup(${allDemoIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">inventory_2</span></div>
      <div class="summary-card-label">Product Models</div>
      <div class="summary-card-value">${data.length}</div>
      <div class="summary-card-sub">Tap to browse</div>
    </div>
    <div class="summary-card orange clickable-summary-card" onclick="openDemoFilterPopup(${demoFilterIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">local_library</span></div>
      <div class="summary-card-label">Demo Stock</div>
      <div class="summary-card-value">${totalDemo}</div>
      <div class="summary-card-sub">Demo units</div>
    </div>
    <div class="summary-card blue clickable-summary-card" onclick="openDemoFilterPopup(${supportFilterIdx})">
      <div class="summary-card-icon"><span class="material-symbols-rounded">support_agent</span></div>
      <div class="summary-card-label">Support Stock</div>
      <div class="summary-card-value">${totalSupport}</div>
      <div class="summary-card-sub">Support units</div>
    </div>
    <div class="summary-card green">
      <div class="summary-card-icon"><span class="material-symbols-rounded">stacked_bar_chart</span></div>
      <div class="summary-card-label">Total Stock</div>
      <div class="summary-card-value">${totalAll}</div>
      <div class="summary-card-sub">Combined total</div>
    </div>`;
}

// ===================================
// DEMO TABLE
// ===================================

function renderDemoTable(data, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="no-data">No data available.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((row) => {
    const idx     = storeForPopup({ type: "demo", row });
    const model   = row["Product Model"] || "";
    const demo    = (row["Demo"]    !== undefined && row["Demo"]    !== "") ? row["Demo"]    : "—";
    const support = (row["Support"] !== undefined && row["Support"] !== "") ? row["Support"] : "—";
    const total   = row["Total Stock"] ?? "—";

    return `
      <tr>
        <td class="clickable-cell" onclick="openDemoProductDetailDirect(${idx})">${escHtml(model)}</td>
        <td>${demo}</td>
        <td>${support}</td>
        <td>${total}</td>
      </tr>`;
  }).join("");
}

// ===================================
// ██ POPUP FLOWS ████████████████████
// ===================================

function getProductConfig(viewType) {
  switch (viewType) {
    case "at":   return { data: cachedData.atProducts   || [], title: "A&T Products" };
    case "aver": return { data: cachedData.averProducts || [], title: "Aver Products" };
    default:     return { data: [], title: "Products" };
  }
}

// ── Shared product list card builder ──────────────────────────────────────────
// navigateFn is the name of the JS function to call with the storeIdx on tap.

function buildProductListHtml(products, viewType, navigateFn) {
  if (!products.length) return '<p class="no-data">No products found.</p>';

  return `<div class="popup-prod-list">${products.map((row) => {
    const idx      = storeForPopup({ type: viewType, row });
    const model    = row["Product Model"] || "";
    const salable  = row["Salable Stock"]  !== undefined ? row["Salable Stock"]  : "";
    const ho       = row["Stock at HO"]    !== undefined ? row["Stock at HO"]    : "";
    const mfg      = row["Stock at MFG"]   !== undefined ? row["Stock at MFG"]   : "";
    const reserved = row["Reserved Stock"] !== undefined ? row["Reserved Stock"] : "";

    const stats = [];
    if (salable  !== "") stats.push(`<span class="popup-prod-stat">Salable: <strong>${salable}</strong></span>`);
    if (ho       !== "") stats.push(`<span class="popup-prod-stat">HO: <strong>${ho}</strong></span>`);
    if (mfg      !== "") stats.push(`<span class="popup-prod-stat">MFG: <strong>${mfg}</strong></span>`);
    if (reserved !== "") stats.push(`<span class="popup-prod-stat">Reserved: <strong>${reserved}</strong></span>`);

    return `
      <div class="popup-prod-card" onclick="${navigateFn}(${idx})">
        <div class="popup-prod-info">
          <div class="popup-prod-name">${escHtml(model)}</div>
          ${stats.length ? `<div class="popup-prod-stats">${stats.join("")}</div>` : ""}
        </div>
        <span class="popup-prod-arrow material-symbols-rounded">chevron_right</span>
      </div>`;
  }).join("")}</div>`;
}

// ── FLOW A: Stock at HO / MFG ─────────────────────────────────────────────────
// Level 0 → Level 1

function openStockFilterPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { products, label } = stored;

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(label)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""} in stock</p>
    </div>
    <div class="popup-body">
      ${buildProductListHtml(products, stored.viewType, "navToStockProductDetail")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 1 — pushed
function navToStockProductDetail(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar("Stock Products")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      ${cat ? `<p>${escHtml(cat)}</p>` : ""}
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row, ["Category"])}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ── FLOW B: Demo / Support Filter ─────────────────────────────────────────────
// Level 0 → Level 1

function openDemoFilterPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { products, label } = stored;

  const cardsHtml = products.length
    ? `<div class="popup-prod-list">${products.map((row) => {
        const idx     = storeForPopup({ type: "demo", row });
        const model   = row["Product Model"] || "";
        const demo    = row["Demo"]    !== undefined ? row["Demo"]    : "—";
        const support = row["Support"] !== undefined ? row["Support"] : "—";
        const total   = row["Total Stock"] ?? "—";

        return `
          <div class="popup-prod-card" onclick="navToDemoDetailFromFilter(${idx})">
            <div class="popup-prod-info">
              <div class="popup-prod-name">${escHtml(model)}</div>
              <div class="popup-prod-stats">
                <span class="popup-prod-stat">Demo: <strong>${demo}</strong></span>
                <span class="popup-prod-stat">Support: <strong>${support}</strong></span>
                <span class="popup-prod-stat">Total: <strong>${total}</strong></span>
              </div>
            </div>
            <span class="popup-prod-arrow material-symbols-rounded">chevron_right</span>
          </div>`;
      }).join("")}</div>`
    : '<p class="no-data">No products found.</p>';

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(label)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""} in stock</p>
    </div>
    <div class="popup-body">
      ${cardsHtml}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 1 — pushed
function navToDemoDetailFromFilter(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  pushPopup(buildDemoDetailHtml(stored.row, "Demo / Support Filter"));
}

// ── FLOW C: Category Summary Card ─────────────────────────────────────────────
// Level 0 → Level 1 → Level 2

function openCategoryListPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, categories } = stored;
  const { data, title } = getProductConfig(viewType);

  const catsHtml = categories.map((cat) => {
    const count  = data.filter(r => r["Category"] === cat).length;
    const catIdx = storeForPopup({ __catNav: true, viewType, cat });
    return `
      <div class="cat-card" onclick="navToCategoryProducts(${catIdx})">
        <div class="cat-card-icon">
          <span class="material-symbols-rounded">folder_open</span>
        </div>
        <div class="cat-card-name">${escHtml(cat)}</div>
        <div class="cat-card-count">${count} product${count !== 1 ? "s" : ""}</div>
      </div>`;
  }).join("");

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p>${categories.length} categories — select one</p>
    </div>
    <div class="popup-body no-pad">
      <div class="cat-cards-grid">${catsHtml}</div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 1 — pushed
function navToCategoryProducts(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, cat } = stored;
  const { data } = getProductConfig(viewType);
  const products  = data.filter(r => r["Category"] === cat);

  pushPopup(`
    ${popupNavBar("Categories")}
    <div class="popup-header">
      <h3>${escHtml(cat)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="popup-body">
      ${buildProductListHtml(products, viewType, "navToProductDetailFromCategory")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 2 — pushed
function navToProductDetailFromCategory(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar("Products")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      ${cat ? `<p>${escHtml(cat)}</p>` : ""}
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row, ["Category"])}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ── FLOW D: Product Models Summary Card ───────────────────────────────────────
// Level 0 (chip filter list) → Level 1 (product detail)

function openAllProductsPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, data } = stored;
  const { title }    = getProductConfig(viewType);
  const categories   = [...new Set(data.map(r => r["Category"]).filter(Boolean))];

  const chipsHtml = [
    `<span class="popup-chip active" onclick="filterPopupProducts('all','${viewType}',this)">All</span>`,
    ...categories.map(cat => {
      const safe = cat.replace(/'/g, "\\'").replace(/"/g, "&quot;");
      return `<span class="popup-chip" onclick="filterPopupProducts('${escHtml(safe)}','${viewType}',this)">${escHtml(cat)}</span>`;
    })
  ].join("");

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p>All Products (${data.length})</p>
    </div>
    <div class="popup-chip-bar" id="popupChipBar">${chipsHtml}</div>
    <div class="popup-body" id="allProductsBody">
      ${buildProductListHtml(data, viewType, "navToProductDetailFromAll")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

function filterPopupProducts(cat, viewType, chipEl) {
  document.querySelectorAll(".popup-chip").forEach(c => c.classList.remove("active"));
  if (chipEl) chipEl.classList.add("active");

  const { data } = getProductConfig(viewType);
  const filtered  = cat === "all" ? data : data.filter(r => r["Category"] === cat);
  const body      = document.getElementById("allProductsBody");
  if (body) body.innerHTML = buildProductListHtml(filtered, viewType, "navToProductDetailFromAll");
}

// Level 1 — pushed
function navToProductDetailFromAll(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar("All Products")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      ${cat ? `<p>${escHtml(cat)}</p>` : ""}
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row, ["Category"])}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ── FLOW E: Table Row — Category Cell ─────────────────────────────────────────
// Level 0 (product list with chip switcher) → Level 1 (product detail)

function openCategoryClickPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, selectedCategory } = stored;
  const { data, title } = getProductConfig(viewType);
  const categories = [...new Set(data.map(r => r["Category"]).filter(Boolean))];
  const products   = data.filter(r => r["Category"] === selectedCategory);

  const chipsHtml = categories.map((cat) => {
    const safe = cat.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    return `<span class="popup-chip ${cat === selectedCategory ? "active" : ""}" onclick="switchCategoryInPopup('${escHtml(safe)}','${viewType}',this)">${escHtml(cat)}</span>`;
  }).join("");

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p id="catPopupSubtitle">${escHtml(selectedCategory)}</p>
    </div>
    <div class="popup-chip-bar" id="catChipBar">${chipsHtml}</div>
    <div class="popup-body" id="catProductBody">
      ${buildProductListHtml(products, viewType, "navToProductDetailFromCat")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

function switchCategoryInPopup(cat, viewType, chipEl) {
  document.querySelectorAll("#catChipBar .popup-chip").forEach(c => c.classList.remove("active"));
  if (chipEl) chipEl.classList.add("active");

  const subtitle = document.getElementById("catPopupSubtitle");
  if (subtitle) subtitle.textContent = cat;

  const { data } = getProductConfig(viewType);
  const products  = data.filter(r => r["Category"] === cat);
  const body      = document.getElementById("catProductBody");
  if (body) body.innerHTML = buildProductListHtml(products, viewType, "navToProductDetailFromCat");
}

// Level 1 — pushed
function navToProductDetailFromCat(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar("Products")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      ${cat ? `<p>${escHtml(cat)}</p>` : ""}
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row, ["Category"])}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ── FLOW F: Table Row — Product Cell  ─────────────────────────────────────────
// Level 0 only (direct detail, no back needed)

function openProductDetailDirect(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  // Level 0 — no parent to go back to
  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      ${cat ? `<p>${escHtml(cat)}</p>` : ""}
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row, ["Category"])}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ── FLOW G: Demo — Product Models Summary Card ─────────────────────────────────
// Level 0 → Level 1

function openAllDemoProductsPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { data } = stored;

  const cardsHtml = `<div class="popup-prod-list">${data.map((row) => {
    const idx     = storeForPopup({ type: "demo", row });
    const model   = row["Product Model"] || "";
    const demo    = row["Demo"]    !== undefined ? row["Demo"]    : "—";
    const support = row["Support"] !== undefined ? row["Support"] : "—";
    const total   = row["Total Stock"] ?? "—";

    return `
      <div class="popup-prod-card" onclick="navToDemoDetailFromAll(${idx})">
        <div class="popup-prod-info">
          <div class="popup-prod-name">${escHtml(model)}</div>
          <div class="popup-prod-stats">
            <span class="popup-prod-stat">Demo: <strong>${demo}</strong></span>
            <span class="popup-prod-stat">Support: <strong>${support}</strong></span>
            <span class="popup-prod-stat">Total: <strong>${total}</strong></span>
          </div>
        </div>
        <span class="popup-prod-arrow material-symbols-rounded">chevron_right</span>
      </div>`;
  }).join("")}</div>`;

  // Level 0
  showPopup(`
    <div class="popup-header">
      <h3>Demo Products</h3>
      <p>All Models (${data.length})</p>
    </div>
    <div class="popup-body">
      ${cardsHtml}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 1 — pushed
function navToDemoDetailFromAll(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  pushPopup(buildDemoDetailHtml(stored.row, "Demo Products"));
}

// ── FLOW H: Demo Table Row — Product Cell ─────────────────────────────────────
// Level 0 only (direct detail)

function openDemoProductDetailDirect(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  // Level 0 — no parent to go back to
  showPopup(buildDemoDetailHtml(stored.row, null));
}

// ── Demo Detail Builder ────────────────────────────────────────────────────────

/**
 * Builds the inner HTML for a demo product detail popup.
 * @param {object} row        - merged demo row
 * @param {string|null} backLabel - label for the popupNavBar back button,
 *                                  or null if this is a Level 0 popup (no back bar)
 */
function buildDemoDetailHtml(row, backLabel) {
  const model   = row["Product Model"] || "Product Details";
  const demo    = (row["Demo"]    !== undefined && row["Demo"]    !== "") ? row["Demo"]    : "—";
  const support = (row["Support"] !== undefined && row["Support"] !== "") ? row["Support"] : "—";
  const total   = row["Total Stock"] ?? "—";

  let rawRowsHtml = "";
  if (row.__rawRows && row.__rawRows.length) {
    const excludeKeys = new Set(["Product Model", "PRODUCT MODEL"]);
    const allKeys = [];
    row.__rawRows.forEach(r => {
      Object.keys(r).forEach(k => {
        if (!excludeKeys.has(k) && !allKeys.includes(k)) allKeys.push(k);
      });
    });

    if (allKeys.length) {
      const bodyRows = row.__rawRows.map((r, i) => {
        const innerRows = allKeys.map(k => {
          const val     = r[k];
          const display = (val !== undefined && val !== null && val !== "") ? String(val) : "—";
          return `<tr><td class="detail-label">${escHtml(k)}</td><td class="detail-value">${escHtml(display)}</td></tr>`;
        }).join("");

        return `
          <div class="breakdown-card">
            <div class="breakdown-title">Entry ${i + 1}</div>
            <table class="detail-table"><tbody>${innerRows}</tbody></table>
          </div>`;
      }).join("");

      rawRowsHtml = `
        <div class="popup-raw-rows-section">
          <button class="view-breakdown-btn" onclick="toggleBreakdown()">See Location Breakdown</button>
          <div id="breakdownContainer" style="display:none; margin-top:12px;">${bodyRows}</div>
        </div>`;
    }
  }

  return `
    ${backLabel ? popupNavBar(backLabel) : ""}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      <p>Demo Product Details</p>
    </div>
    <div class="popup-body">
      <table class="detail-table demo-detail-table">
        <thead>
          <tr>
            <th class="detail-label-th">Type</th>
            <th class="detail-value-th">Units</th>
          </tr>
        </thead>
        <tbody>
          <tr><td class="detail-label">Demo Stock</td><td class="detail-value">${demo}</td></tr>
          <tr><td class="detail-label">Support Stock</td><td class="detail-value">${support}</td></tr>
        </tbody>
      </table>
      <div class="demo-combined-total">
        <span>Combined Total Stock</span>
        <strong>${total}</strong>
      </div>
      ${rawRowsHtml}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`;
}

function toggleBreakdown() {
  const el = document.getElementById("breakdownContainer");
  if (!el) return;
  const btn = el.previousElementSibling;
  if (el.style.display === "none") {
    el.style.display = "block";
    if (btn) btn.textContent = "Hide Location Breakdown";
  } else {
    el.style.display = "none";
    if (btn) btn.textContent = "See Location Breakdown";
  }
}

// ===================================
// THEME
// ===================================

function initTheme() {
  const savedTheme = localStorage.getItem("dashboard-theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeToggleUI(savedTheme);
}

function initThemeToggle() {
  if (!themeToggle) return;
  themeToggle.querySelectorAll(".theme-option").forEach((option) => {
    option.addEventListener("click", () => setTheme(option.getAttribute("data-theme")));
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("dashboard-theme", theme);
  updateThemeToggleUI(theme);
}

function updateThemeToggleUI(theme) {
  if (!themeToggle) return;
  themeToggle.querySelectorAll(".theme-option").forEach((option) => {
    option.classList.toggle("active", option.getAttribute("data-theme") === theme);
  });
}

// ===================================
// LOGOUT
// ===================================

function initLogout() {
  [logoutBtnSidebar, logoutBtnHeader].forEach((btn) => {
    btn?.addEventListener("click", (e) => {
      e.preventDefault();
      SyncEngine.stop();
      logoutModal?.classList.add("active");
    });
  });
  cancelLogoutBtn?.addEventListener("click", () => {
    logoutModal?.classList.remove("active");
    SyncEngine.start();
  });
  confirmLogoutBtn?.addEventListener("click", () => {
    allowNavigation = true;
    SyncEngine.stop();
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("userRole");
    window.location.replace("Form.html");
  });
  logoutModal?.addEventListener("click", (e) => {
    if (e.target === logoutModal) logoutModal.classList.remove("active");
  });
}