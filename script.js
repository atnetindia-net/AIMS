// ===================================
// 🔐 AUTH CHECK
// ===================================
// ✅ Uses localStorage for persistence (survives app restarts)

(function() {
  const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";
  const isAdmin    = localStorage.getItem("isAdmin")    === "true";

  if (!isLoggedIn || !isAdmin) {
    window.location.replace("Form.html");
  }
})();


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

// ✅ Default (home) view — back button exits only from here
const DEFAULT_VIEW   = "at-products";

const cachedData = {
  atProducts:   null,
  averProducts: null,
  atDemo:       null,
  averDemo:     null
};

// Popup data store
let popupStore = [];
function storeForPopup(data) { popupStore.push(data); return popupStore.length - 1; }
function clearPopupStore()   { popupStore = []; }

// ✅ Popup navigation stack — tracks depth for back button
let popupStack = [];

// ===================================
// ██ REAL-TIME SYNC ENGINE ████████████
// ===================================

const SyncEngine = (() => {
  const SYNC_INTERVAL_MS  = 2000;
  const SHEET_KEYS        = ["atProducts", "averProducts", "atDemo", "averDemo"];

  let lastSyncTime        = 0;
  let rafHandle           = null;
  let isSyncing           = false;
  let isPageVisible       = !document.hidden;
  let syncActive          = false;

  const lastFetchTime = { atProducts: 0, averProducts: 0, atDemo: 0, averDemo: 0 };
  const STAGGER_OFFSETS = { atProducts: 0, averProducts: 500, atDemo: 1000, averDemo: 1500 };

  function fingerprint(data) {
    if (!data || !Array.isArray(data)) return "";
    return data.map((row, i) => {
      const vals = Object.values(row).join("|");
      return `${i}:${vals.length}:${vals.slice(0, 40)}`;
    }).join("||");
  }

  const fingerprints = { atProducts: "", averProducts: "", atDemo: "", averDemo: "" };

  function showSyncDot(state) {
    let dot = document.getElementById("syncStatusDot");
    if (!dot) {
      dot = document.createElement("div");
      dot.id = "syncStatusDot";
      dot.style.cssText = `
        position: fixed; bottom: 18px; right: 18px;
        width: 10px; height: 10px; border-radius: 50%;
        z-index: 9999; transition: background 0.3s, box-shadow 0.3s;
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
      atProducts: "at-products", averProducts: "aver-products",
      atDemo: "at-demo",         averDemo: "aver-demo"
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
    if (isPageVisible) SHEET_KEYS.forEach(key => { lastFetchTime[key] = 0; });
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

  function invalidate(key) { fingerprints[key] = ""; lastFetchTime[key] = 0; }
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
// EXIT CONFIRMATION MODAL
// ===================================
// ✅ Separate modal for "exit app" (not logout)

function createExitModal() {
  if (document.getElementById("exitModal")) return;
  const modal = document.createElement("div");
  modal.id        = "exitModal";
  modal.className = "logout-modal"; // reuse same styles
  modal.innerHTML = `
    <div class="logout-box">
      <h3>Exit App</h3>
      <p>Press back again to exit, or stay on this page.</p>
      <div class="logout-actions">
        <button class="btn cancel-btn" id="cancelExit">Stay</button>
        <button class="btn confirm-btn" id="confirmExit">Exit</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById("cancelExit").addEventListener("click", () => {
    modal.classList.remove("active");
  });
  document.getElementById("confirmExit").addEventListener("click", () => {
    // For APK / WebView: attempt to close the window
    allowNavigation = true;
    window.close();
    // Fallback: go back in browser history
    history.go(-(history.length - 1));
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("active");
  });
}

function showExitModal() {
  const modal = document.getElementById("exitModal");
  if (modal) modal.classList.add("active");
}

function hideExitModal() {
  const modal = document.getElementById("exitModal");
  if (modal) modal.classList.remove("active");
}

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
  createExitModal();
  initBackControl();
  loadView(DEFAULT_VIEW);

  setTimeout(() => SyncEngine.start(), 2500);
});

// ===================================
// ✅ BACK BUTTON CONTROL (FIXED)
// ===================================
/**
 * Navigation hierarchy (Admin):
 *   Popup Level 2 (Product Detail) → back → Popup Level 1 (Product List / Category List)
 *   Popup Level 1 (Category List)  → back → Close Popup → stay on current view
 *   Non-default view (e.g. Aver)   → back → Default view (A&T Products)
 *   Default view (A&T Products)    → back → Exit confirmation (NOT logout)
 *
 * History states used:
 *   { type: "popup-deep" }   — inside a popup with back stack > 0
 *   { type: "popup-root" }   — popup is open at root level (stack = 0)
 *   { type: "view", view }   — a non-default dashboard view
 *   { type: "home" }         — the default home view
 */

let exitBackPressCount = 0;
let exitBackTimer      = null;

function initBackControl() {
  // Push initial home state
  history.replaceState({ type: "home" }, "");

  window.addEventListener("popstate", function (e) {
    const state = e.state;

    // ── Case 1: Inside popup with back stack (Product Detail level) ──
    if (popupStack.length > 0) {
      popupBack();
      // Re-push a state so next back has something to pop
      history.pushState({ type: "popup-deep" }, "");
      return;
    }

    // ── Case 2: Popup is open at root level → close popup ──
    const overlay = document.getElementById("inventoryPopup");
    if (overlay && overlay.classList.contains("active")) {
      closePopup();
      // Re-push current view state so next back works correctly
      const stateType = (currentView === DEFAULT_VIEW) ? "home" : "view";
      history.pushState({ type: stateType, view: currentView }, "");
      return;
    }

    // ── Case 3: On a non-default view → navigate to home ──
    if (currentView !== DEFAULT_VIEW) {
      loadView(DEFAULT_VIEW);
      // Update sidebar active item
      document.querySelectorAll(".dashboard-nav-item").forEach(i => {
        i.classList.toggle("active", i.getAttribute("data-view") === DEFAULT_VIEW);
      });
      history.replaceState({ type: "home" }, "");
      return;
    }

    // ── Case 4: Already on home → show exit confirmation ──
    history.pushState({ type: "home" }, ""); // keep history intact
    showExitModal();
  });

  // Prevent accidental page unload
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

  // ✅ Push correct history state for back button
  if (viewId === DEFAULT_VIEW) {
    history.replaceState({ type: "home" }, "");
  } else {
    history.pushState({ type: "view", view: viewId }, "");
  }

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
// ██████ POPUP NAVIGATION SYSTEM ████
// ===================================
/**
 * ✅ FIXED: Popup stack correctly manages browser history states.
 *
 * showPopup()  → resets stack, pushes 1 history state (popup-root)
 * pushPopup()  → saves current HTML to stack, pushes history state (popup-deep)
 * popupBack()  → pops HTML, restores previous content
 *               (history state is popped automatically by back button)
 * closePopup() → resets everything, no history push needed
 */

function getOrCreateOverlay() {
  let overlay = document.getElementById("inventoryPopup");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id        = "inventoryPopup";
    overlay.className = "inventory-popup-overlay";
    document.body.appendChild(overlay);
    // Clicking outside closes popup
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePopup(); });
    // Escape key closes popup
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });
  }
  return overlay;
}

/**
 * Open a FRESH popup — resets navigation stack.
 * Pushes one history state so back button can close it.
 */
function showPopup(innerHtml) {
  popupStack = [];
  const overlay = getOrCreateOverlay();
  overlay.innerHTML = `<div class="inventory-popup-box">${innerHtml}</div>`;
  overlay.classList.add("active");
  // ✅ Push history state so back button handler can close this popup
  history.pushState({ type: "popup-root" }, "");
}

/**
 * Navigate deeper inside popup.
 * Saves current HTML, pushes history state.
 */
function pushPopup(innerHtml) {
  const overlay = getOrCreateOverlay();
  const box     = overlay.querySelector(".inventory-popup-box");
  if (box) {
    popupStack.push(box.innerHTML);
    box.innerHTML = innerHtml;
    // ✅ Push history state so back button knows we're deep
    history.pushState({ type: "popup-deep" }, "");
  } else {
    showPopup(innerHtml);
  }
}

/**
 * Go back one popup level.
 * Called by inline back buttons (not the browser back button).
 */
function popupBack() {
  if (popupStack.length === 0) {
    closePopup();
    return;
  }
  const prev    = popupStack.pop();
  const overlay = document.getElementById("inventoryPopup");
  const box     = overlay?.querySelector(".inventory-popup-box");
  if (box) box.innerHTML = prev;
  // ✅ If this was the last stack item, we're now at popup-root level
  // The browser history state remains in sync via popstate handler
}

/**
 * Close popup completely — clear stack, remove active class.
 */
function closePopup() {
  popupStack = [];
  const overlay = document.getElementById("inventoryPopup");
  if (overlay) overlay.classList.remove("active");
}

// Reusable back-button bar HTML
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

// ── Stock at HO / MFG FLOW ─────────

function openStockFilterPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, products, label } = stored;

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(label)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""} in stock</p>
    </div>
    <div class="popup-body">
      ${buildProductListHtml(products, viewType, "navToProductDetailFromStock")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

function navToProductDetailFromStock(storeIdx) {
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

// ── Demo / Support Filter FLOW ──────

function openDemoFilterPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { products, label } = stored;

  const cardsHtml = `<div class="popup-prod-list">${products.map((row) => {
    const idx     = storeForPopup({ type: "demo", row });
    const model   = row["Product Model"] || "";
    const demo    = row["Demo"]    !== undefined ? row["Demo"]    : "—";
    const support = row["Support"] !== undefined ? row["Support"] : "—";
    const total   = row["Total Stock"] ?? "—";

    return `
      <div class="popup-prod-card" onclick="navToDemoProductDetailFromFilter(${idx})">
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

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(label)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""} in stock</p>
    </div>
    <div class="popup-body">
      ${products.length ? cardsHtml : '<p class="no-data">No products found.</p>'}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

function navToDemoProductDetailFromFilter(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  pushPopup(buildDemoDetailHtml(stored.row, true));
}

// ── FLOW 1: Category Summary Card ───

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

function navToCategoryProducts(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, cat } = stored;
  const { data } = getProductConfig(viewType);
  const products = data.filter(r => r["Category"] === cat);

  pushPopup(`
    ${popupNavBar("Categories")}
    <div class="popup-header">
      <h3>${escHtml(cat)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="popup-body">
      ${buildProductListHtml(products, viewType, "navToProductDetail")}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

function navToProductDetail(storeIdx) {
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

// ── FLOW 2: Product Models Summary Card ─

function openAllProductsPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, data } = stored;
  const { title } = getProductConfig(viewType);
  const categories = [...new Set(data.map(r => r["Category"]).filter(Boolean))];

  const chipsHtml = [
    `<span class="popup-chip active" onclick="filterPopupProducts('all','${viewType}',this)">All</span>`,
    ...categories.map(cat => {
      const safe = cat.replace(/'/g, "\\'").replace(/"/g, "&quot;");
      return `<span class="popup-chip" onclick="filterPopupProducts('${escHtml(safe)}','${viewType}',this)">${escHtml(cat)}</span>`;
    })
  ].join("");

  const listHtml = buildProductListHtml(data, viewType, "navToProductDetailFromAll");

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p>All Products (${data.length})</p>
    </div>
    <div class="popup-chip-bar" id="popupChipBar">${chipsHtml}</div>
    <div class="popup-body" id="allProductsBody">
      ${listHtml}
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

// ── FLOW 3: Table Row — Category Cell ─

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

// ── FLOW 4: Table Row — Product Cell ─

function openProductDetailDirect(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

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

// ── FLOW 5: Demo — Product Models Summary Card ─

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
      <div class="popup-prod-card" onclick="navToDemoProductDetail(${idx})">
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

function navToDemoProductDetail(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  pushPopup(buildDemoDetailHtml(stored.row, true));
}

// ── FLOW 6: Demo Table Row — Product Cell ─

function openDemoProductDetailDirect(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  showPopup(buildDemoDetailHtml(stored.row, false));
}

// ── Demo Detail Builders ────────────

function buildDemoDetailHtml(row, hasBack) {
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

  const nav = hasBack ? popupNavBar("Demo Products") : "";

  return `
    ${nav}
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
  const el  = document.getElementById("breakdownContainer");
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
// ✅ LOGOUT — Manual only, never from back button
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
    // ✅ Clear ALL session data from localStorage
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("isAdmin");
    localStorage.removeItem("adminName");
    window.location.replace("Form.html");
  });
  logoutModal?.addEventListener("click", (e) => {
    if (e.target === logoutModal) logoutModal.classList.remove("active");
  });
}