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
  atStocks:   "A&T - Current Stock",
  averStocks: "Aver - Current Stock"
};

// ===================================
// 🔄 REAL-TIME SYNC CONFIG
// ===================================

const SYNC_INTERVAL_MS = 2000;
let syncIntervalId     = null;
let isSyncing          = false;

const dataFingerprints = {
  atStocks:   null,
  averStocks: null
};

// ===================================
// GLOBAL STATE
// ===================================

let allowNavigation  = false;
let sidebarCollapsed = false;
let currentView      = "";
let searchQuery      = "";

const cachedData = {
  atStocks:   null,
  averStocks: null
};

// Popup data store — survives DOM redraws
let popupStore = [];
function storeForPopup(data) { popupStore.push(data); return popupStore.length - 1; }
function clearPopupStore()   { popupStore = []; }

// ───────────────────────────────────
// POPUP NAVIGATION STACK
// Each entry is the innerHTML of .inventory-popup-box at that level.
// pushPopup() saves current level before replacing it.
// popupBack() restores the previous level.
// ───────────────────────────────────
let popupStack = [];

// ===================================
// ── BACK BUTTON: Exit confirmation ──
// ===================================

let backPressCount = 0;
let backPressTimer = null;

/**
 * Central handler for the hardware back button.
 *
 * Priority order:
 *   1. If the EXIT confirmation modal is open → do nothing (let its own buttons handle it)
 *   2. If the inventory popup is open → navigate within it (popupBack / closePopup)
 *   3. Otherwise → count toward exit; on 4th press show the exit confirmation modal
 */
function handleHardwareBack() {
  // 1. If exit-confirmation modal is already showing, absorb the press silently.
  const exitModal = document.getElementById("exitConfirmModal");
  if (exitModal && exitModal.classList.contains("active")) {
    // Re-push so the next popstate fires correctly
    window.history.pushState(null, null, window.location.href);
    return;
  }

  // 2. If inventory popup is open, navigate within it first.
  const overlay = document.getElementById("inventoryPopup");
  if (overlay && overlay.classList.contains("active")) {
    if (popupStack.length > 0) {
      popupBack();
    } else {
      closePopup();
    }
    // Reset exit counter whenever the popup absorbs a press
    backPressCount = 0;
    clearTimeout(backPressTimer);
    return;
  }

  // 3. No popup open — count toward exit (need 4 presses to show modal)
  backPressCount++;
  clearTimeout(backPressTimer);

  const remaining = 4 - backPressCount;

  if (backPressCount >= 4) {
    // Show the exit confirmation modal instead of exiting immediately
    backPressCount = 0;
    clearTimeout(backPressTimer);
    showExitConfirmModal();
    return;
  }

  // Show a subtle toast hint
  showExitToast(
    remaining === 1
      ? "Press back once more to exit"
      : `Press back ${remaining} more times to exit`
  );

  // Reset counter after 2.5 s of inactivity
  backPressTimer = setTimeout(() => { backPressCount = 0; }, 2500);

  window.history.pushState(null, null, window.location.href);
}

// ===================================
// EXIT CONFIRMATION MODAL
// ===================================

/**
 * Creates (once) and shows a modal that asks "Are you sure you want to exit?"
 * Confirm → exits the app.  Cancel → stays in the app.
 */
function showExitConfirmModal() {
  let modal = document.getElementById("exitConfirmModal");

  if (!modal) {
    modal = document.createElement("div");
    modal.id        = "exitConfirmModal";
    modal.className = "logout-modal"; // reuse existing modal styles
    modal.innerHTML = `
      <div class="logout-box">
        <h3>Exit App</h3>
        <p>Are you sure you want to exit?</p>
        <div class="logout-actions">
          <button class="btn cancel-btn"  id="exitConfirmCancel">Cancel</button>
          <button class="btn confirm-btn" id="exitConfirmOk">Exit</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    // Tap outside the box → cancel
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideExitConfirmModal();
    });

    document.getElementById("exitConfirmCancel").addEventListener("click", hideExitConfirmModal);

    document.getElementById("exitConfirmOk").addEventListener("click", () => {
      hideExitConfirmModal();
      allowNavigation = true;
      stopRealTimeSync();
      // Exit the app
      if (window.Android && typeof window.Android.exitApp === "function") {
        window.Android.exitApp();
      } else {
        history.go(-1); // fallback for browser testing
      }
    });
  }

  modal.classList.add("active");
  // Push a state so that a back press while the modal is open is absorbed
  window.history.pushState(null, null, window.location.href);
}

function hideExitConfirmModal() {
  const modal = document.getElementById("exitConfirmModal");
  if (modal) modal.classList.remove("active");
  // Re-push so the next hardware back press fires popstate correctly
  window.history.pushState(null, null, window.location.href);
}

// ===================================
// EXIT TOAST  (hint counter)
// ===================================

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
  loadView("at-stocks");
  startRealTimeSync();
});

// ===================================
// 🔄 REAL-TIME SYNC ENGINE
// ===================================

function startRealTimeSync() {
  if (syncIntervalId !== null) return;

  syncIntervalId = setInterval(async () => {
    if (isSyncing) return;
    isSyncing = true;

    try {
      const [freshAT, freshAver] = await Promise.all([
        fetchSheetData(SHEETS.atStocks),
        fetchSheetData(SHEETS.averStocks)
      ]);

      if (freshAT) {
        const fingerprint = JSON.stringify(freshAT);
        if (fingerprint !== dataFingerprints.atStocks) {
          dataFingerprints.atStocks = fingerprint;
          cachedData.atStocks       = freshAT;
          if (currentView === "at-stocks") silentRefreshView("at-stocks");
        }
      }

      if (freshAver) {
        const fingerprint = JSON.stringify(freshAver);
        if (fingerprint !== dataFingerprints.averStocks) {
          dataFingerprints.averStocks = fingerprint;
          cachedData.averStocks       = freshAver;
          if (currentView === "aver-stocks") silentRefreshView("aver-stocks");
        }
      }
    } catch (err) {
      console.warn("[Sync] Background sync error:", err);
    } finally {
      isSyncing = false;
    }
  }, SYNC_INTERVAL_MS);
}

function stopRealTimeSync() {
  if (syncIntervalId !== null) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

function silentRefreshView(viewId) {
  switch (viewId) {
    case "at-stocks":   silentRefreshATStocks();   break;
    case "aver-stocks": silentRefreshAverStocks(); break;
  }
}

function silentRefreshATStocks() {
  const data = cachedData.atStocks;
  if (!data) return;
  clearPopupStore();
  renderStockSummaryCards(data, "at-stocks-summary", "at");
  renderStockTable(data, "at-stocks-table-body");
  if (searchQuery) filterTableView(searchQuery.toLowerCase(), "at-stocks-table-body", "at-stocks-no-results");
}

function silentRefreshAverStocks() {
  const data = cachedData.averStocks;
  if (!data) return;
  clearPopupStore();
  renderStockSummaryCards(data, "aver-stocks-summary", "aver");
  renderStockTable(data, "aver-stocks-table-body");
  if (searchQuery) filterTableView(searchQuery.toLowerCase(), "aver-stocks-table-body", "aver-stocks-no-results");
}

// ===================================
// BACK BUTTON CONTROL
// ===================================

function initBackControl() {
  window.history.pushState(null, null, window.location.href);

  window.addEventListener("popstate", function () {
    // Always re-push so every back press fires another popstate
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
  sidebarCollapsed = localStorage.getItem("user-sidebar-collapsed") === "true";
  if (window.innerWidth > 1024) {
    dashboardSidebar.classList.toggle("collapsed", sidebarCollapsed);
  }
  document.querySelectorAll(".dashboard-sidebar-toggle").forEach((t) =>
    t.addEventListener("click", toggleSidebar)
  );
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
    localStorage.setItem("user-sidebar-collapsed", sidebarCollapsed.toString());
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
  "at-stocks":   "A&T Stocks",
  "aver-stocks": "Aver Stocks"
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
    case "at-stocks":   loadATStocks();   break;
    case "aver-stocks": loadAverStocks(); break;
  }

  if (window.innerWidth <= 1024) closeSidebar();
}

// ===================================
// DATA FETCHING
// ===================================

async function fetchSheetData(sheetName) {
  try {
    const cacheBust = `&_=${Date.now()}`;
    const response  = await fetch(`${SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}${cacheBust}`, {
      cache: "no-store"
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (err) {
    console.error(`Error fetching "${sheetName}":`, err);
    return null;
  }
}

// ===================================
// LOADING & ERROR STATES
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
// LIVE SEARCH
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
    case "at-stocks":   filterTableView(q, "at-stocks-table-body",   "at-stocks-no-results");   break;
    case "aver-stocks": filterTableView(q, "aver-stocks-table-body", "aver-stocks-no-results"); break;
  }
}

function filterTableView(q, tableBodyId, noResultsId) {
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

  if (noResults) {
    noResults.style.display = (q && rowVisible === 0) ? "flex" : "none";
  }
}

// ===================================
// UTILITY
// ===================================

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#039;");
}

function escAttr(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g,  "\\'");
}

function buildAllFieldsTable(row) {
  const skipKeys = new Set(["Category", "Product Model"]);
  const rows = Object.entries(row)
    .filter(([key, val]) => !skipKeys.has(key) && val !== "" && val !== null && val !== undefined)
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
// ── A&T STOCKS ──
// ===================================

async function loadATStocks() {
  showLoading("at-stocks-summary");
  showLoading("at-stocks-table-body");

  if (!cachedData.atStocks) {
    cachedData.atStocks = await fetchSheetData(SHEETS.atStocks);
    if (cachedData.atStocks) {
      dataFingerprints.atStocks = JSON.stringify(cachedData.atStocks);
    }
  }

  const data = cachedData.atStocks;
  if (!data) { showError("at-stocks-summary", "Failed to load A&T Stocks."); return; }

  clearPopupStore();
  renderStockSummaryCards(data, "at-stocks-summary", "at");
  renderStockTable(data, "at-stocks-table-body");
}

// ===================================
// ── AVER STOCKS ──
// ===================================

async function loadAverStocks() {
  showLoading("aver-stocks-summary");
  showLoading("aver-stocks-table-body");

  if (!cachedData.averStocks) {
    cachedData.averStocks = await fetchSheetData(SHEETS.averStocks);
    if (cachedData.averStocks) {
      dataFingerprints.averStocks = JSON.stringify(cachedData.averStocks);
    }
  }

  const data = cachedData.averStocks;
  if (!data) { showError("aver-stocks-summary", "Failed to load Aver Stocks."); return; }

  clearPopupStore();
  renderStockSummaryCards(data, "aver-stocks-summary", "aver");
  renderStockTable(data, "aver-stocks-table-body");
}

// ===================================
// SUMMARY CARDS RENDERER
// ===================================

function renderStockSummaryCards(data, containerId, viewType) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const categories        = [...new Set(data.map(r => r["Category"]).filter(Boolean))];
  const totalSalable      = data.reduce((s, r) => s + (Number(r["Salable Stock"]) || 0), 0);
  const zeroStockProducts = data.filter(r => (Number(r["Salable Stock"]) || 0) === 0);

  const catCardIdx     = storeForPopup({ __catListPopup: true, viewType, categories });
  const allProdCardIdx = storeForPopup({ __allProductsPopup: true, viewType, data });
  const outOfStockIdx  = storeForPopup({ __outOfStock: true, viewType, products: zeroStockProducts });

  container.innerHTML = `
    <div class="summary-card purple clickable-summary-card" onclick="openCategoryListPopup(${catCardIdx})" title="Click to browse categories">
      <div class="summary-card-icon"><span class="material-symbols-rounded">category</span></div>
      <div class="summary-card-label">Categories</div>
      <div class="summary-card-value">${categories.length}</div>
      <div class="summary-card-sub">Unique categories</div>
    </div>
    <div class="summary-card blue clickable-summary-card" onclick="openAllProductsPopup(${allProdCardIdx})" title="Click to browse all products">
      <div class="summary-card-icon"><span class="material-symbols-rounded">inventory_2</span></div>
      <div class="summary-card-label">Product Models</div>
      <div class="summary-card-value">${data.length}</div>
      <div class="summary-card-sub">Total models</div>
    </div>
    <div class="summary-card green">
      <div class="summary-card-icon"><span class="material-symbols-rounded">sell</span></div>
      <div class="summary-card-label">Total Salable</div>
      <div class="summary-card-value">${totalSalable}</div>
      <div class="summary-card-sub">Units available</div>
    </div>
    <div class="summary-card red clickable-summary-card" onclick="openOutOfStockPopup(${outOfStockIdx})" title="Click to see out of stock products">
      <div class="summary-card-icon"><span class="material-symbols-rounded">remove_shopping_cart</span></div>
      <div class="summary-card-label">Out of Stock</div>
      <div class="summary-card-value">${zeroStockProducts.length}</div>
      <div class="summary-card-sub">Models at zero</div>
    </div>`;
}

// ===================================
// TABLE RENDERER
// ===================================

function renderStockTable(data, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="no-data">No data available.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((row) => {
    const idx      = storeForPopup({ row });
    const category = row["Category"]      || "";
    const model    = row["Product Model"] || "";
    const salable  = row["Salable Stock"] ?? "";

    const vt     = currentView === "at-stocks" ? "at" : "aver";
    const catIdx = storeForPopup({ __catPopup: true, viewType: vt, selectedCategory: category });

    const stockNum = Number(salable);
    let stockClass = "";
    if (salable !== "" && !isNaN(stockNum)) {
      if (stockNum === 0)      stockClass = "stock-zero";
      else if (stockNum <= 5)  stockClass = "stock-low";
      else                     stockClass = "stock-ok";
    }

    return `
      <tr>
        <td class="clickable-cell cat-cell" onclick="openCategoryPopup(${catIdx})">${escHtml(category)}</td>
        <td class="clickable-cell" onclick="openProductPopup(${idx})">${escHtml(model)}</td>
        <td><span class="${stockClass}">${salable}</span></td>
      </tr>`;
  }).join("");
}

// ===================================
// ██ POPUP NAVIGATION SYSTEM █████████
// ===================================
//
//  showPopup(html)  — opens a fresh popup; resets the stack (Level 0)
//  pushPopup(html)  — saves current content to stack, shows new content (Level N+1)
//  popupBack()      — restores previous content from stack (Level N-1)
//  closePopup()     — hides overlay, clears stack
//
// Hardware back key calls popupBack() when stack has entries,
// and closePopup() when the stack is empty (Level 0).
// ────────────────────────────────────

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
  popupStack = [];   // fresh flow — clear any previous stack
  const overlay = getOrCreateOverlay();
  overlay.innerHTML = `<div class="inventory-popup-box">${innerHtml}</div>`;
  overlay.classList.add("active");
}

/** Push current popup content onto the stack and show new content (Level N+1). */
function pushPopup(innerHtml) {
  const overlay = getOrCreateOverlay();
  const box     = overlay.querySelector(".inventory-popup-box");
  if (box) {
    popupStack.push(box.innerHTML);   // save current level
    box.innerHTML = innerHtml;
  } else {
    // Overlay not yet open — treat as a fresh open
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

// Back button row inside popup (icon only, no label)
function popupNavBar(label) {
  return `
    <div class="popup-header-with-back">
      <button class="popup-back-btn" onclick="popupBack()" title="Back">
        <span class="material-symbols-rounded">arrow_back_ios_new</span>
      </button>
      <div class="popup-header-text">
        <h3>${escHtml(label)}</h3>
      </div>
      <div style="width:32px; flex-shrink:0;"></div>
    </div>`;
}

// ===================================
// ── OUT OF STOCK POPUP  (Level 0) ──
// ===================================

function openOutOfStockPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { products } = stored;

  if (!products.length) {
    showPopup(`
      <div class="popup-header">
        <h3>Out of Stock</h3>
        <p>No products at zero stock</p>
      </div>
      <div class="popup-body" style="text-align:center; padding: 2rem;">
        <span class="material-symbols-rounded" style="font-size:2.5rem; color:var(--color-success); display:block; margin-bottom:.5rem;">check_circle</span>
        <p style="color:var(--color-text-muted); font-size:var(--text-sm);">All products are in stock!</p>
      </div>
      <div class="popup-footer">
        <button class="close-btn" onclick="closePopup()">Close</button>
      </div>`);
    return;
  }

  const productCards = products.map((row) => {
    const idx      = storeForPopup({ row });
    const model    = row["Product Model"] || "";
    const category = row["Category"]      || "";

    return `
      <div class="step-product-card" onclick="navToOutOfStockDetail(${idx})">
        <div class="step-product-info">
          <span class="step-product-name">${escHtml(model)}</span>
          <span class="step-product-stock">${escHtml(category)}</span>
        </div>
        <span class="stock-zero" style="font-size:var(--text-xs); font-weight:var(--weight-semibold); margin-right:4px;">0</span>
        <span class="material-symbols-rounded step-category-arrow">chevron_right</span>
      </div>`;
  }).join("");

  showPopup(`
    <div class="popup-header">
      <h3>Out of Stock</h3>
      <p>${products.length} model${products.length !== 1 ? "s" : ""} at zero stock</p>
    </div>
    <div class="popup-body popup-step-body">
      <div class="step-label">
        <span class="material-symbols-rounded">remove_shopping_cart</span>
        Out of stock products
      </div>
      <div class="step-category-list">
        ${productCards}
      </div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// Level 1 — product detail from Out-of-Stock list
function navToOutOfStockDetail(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar("Out of Stock")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      <p>${escHtml(cat)}</p>
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row)}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// STEP 1a: CATEGORY LIST POPUP  (Level 0)
// ===================================

function openCategoryListPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, categories } = stored;
  if (!categories || !categories.length) return;

  const { title } = getCategoryPopupConfig(viewType);

  const categoryCards = categories.map((cat) => {
    const { data } = getCategoryPopupConfig(viewType);
    const count    = data.filter(r => r["Category"] === cat).length;
    const catIdx   = storeForPopup({ __catNav: true, viewType, cat, origin: "category" });
    return `
      <div class="step-category-card" onclick="navToCategoryProducts(${catIdx})">
        <div class="step-category-card-info">
          <span class="step-category-name">${escHtml(cat)}</span>
          <span class="step-category-count">${count} product${count !== 1 ? "s" : ""}</span>
        </div>
        <span class="material-symbols-rounded step-category-arrow">chevron_right</span>
      </div>`;
  }).join("");

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p>${categories.length} categories</p>
    </div>
    <div class="popup-body popup-step-body">
      <div class="step-label">
        <span class="material-symbols-rounded">category</span>
        Select a category
      </div>
      <div class="step-category-list">
        ${categoryCards}
      </div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// STEP 1b: ALL PRODUCTS POPUP  (Level 0)
// ===================================

function openAllProductsPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, data } = stored;
  const { title }    = getCategoryPopupConfig(viewType);
  const categories   = [...new Set(data.map(r => r["Category"]).filter(Boolean))];

  const categoryCards = categories.map((cat) => {
    const count  = data.filter(r => r["Category"] === cat).length;
    const catIdx = storeForPopup({ __catNav: true, viewType, cat, origin: "all" });
    return `
      <div class="step-category-card" onclick="navToCategoryProducts(${catIdx})">
        <div class="step-category-card-info">
          <span class="step-category-name">${escHtml(cat)}</span>
          <span class="step-category-count">${count} product${count !== 1 ? "s" : ""}</span>
        </div>
        <span class="material-symbols-rounded step-category-arrow">chevron_right</span>
      </div>`;
  }).join("");

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(title)}</h3>
      <p>${data.length} products across ${categories.length} categories</p>
    </div>
    <div class="popup-body popup-step-body">
      <div class="step-label">
        <span class="material-symbols-rounded">category</span>
        Select a category
      </div>
      <div class="step-category-list">
        ${categoryCards}
      </div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// STEP 2: PRODUCT LIST  (Level 1 — pushed)
// ===================================

function navToCategoryProducts(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, cat, origin } = stored;
  const { data } = getCategoryPopupConfig(viewType);
  const products  = data.filter(r => r["Category"] === cat);

  const productCards = products.map((row) => {
    const idx      = storeForPopup({ row, viewType, cat, origin });
    const model    = row["Product Model"] || "";
    const salable  = row["Salable Stock"];
    const stockNum = Number(salable);
    let stockClass = "", stockLabel = "–";
    if (salable !== undefined && salable !== "" && salable !== null) {
      stockLabel = salable;
      if      (stockNum === 0) stockClass = "stock-zero";
      else if (stockNum <= 5)  stockClass = "stock-low";
      else                     stockClass = "stock-ok";
    }

    return `
      <div class="step-product-card" onclick="navToProductDetail(${idx})">
        <div class="step-product-info">
          <span class="step-product-name">${escHtml(model)}</span>
          <span class="step-product-stock ${stockClass}">Stock: ${stockLabel}</span>
        </div>
        <span class="material-symbols-rounded step-category-arrow">chevron_right</span>
      </div>`;
  }).join("");

  pushPopup(`
    ${popupNavBar("Categories")}
    <div class="popup-header">
      <h3>${escHtml(cat)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="popup-body popup-step-body">
      <div class="step-label">
        <span class="material-symbols-rounded">inventory_2</span>
        Select a product
      </div>
      <div class="step-category-list">
        ${productCards || '<p class="no-data">No products found.</p>'}
      </div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// STEP 3: PRODUCT DETAIL  (Level 2 — pushed)
// ===================================

function navToProductDetail(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  pushPopup(`
    ${popupNavBar(escHtml(cat) || "Products")}
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      <p>${escHtml(cat)}</p>
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row)}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// CATEGORY POPUP (table row — category cell)
// ===================================

function openCategoryPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const { viewType, selectedCategory } = stored;
  const { data, title } = getCategoryPopupConfig(viewType);
  const products  = data.filter(r => r["Category"] === selectedCategory);

  const productCards = products.map((row) => {
    const idx      = storeForPopup({ row, viewType, cat: selectedCategory, origin: "table" });
    const model    = row["Product Model"] || "";
    const salable  = row["Salable Stock"];
    const stockNum = Number(salable);
    let stockClass = "", stockLabel = "–";
    if (salable !== undefined && salable !== "" && salable !== null) {
      stockLabel = salable;
      if      (stockNum === 0) stockClass = "stock-zero";
      else if (stockNum <= 5)  stockClass = "stock-low";
      else                     stockClass = "stock-ok";
    }

    return `
      <div class="step-product-card" onclick="navToProductDetail(${idx})">
        <div class="step-product-info">
          <span class="step-product-name">${escHtml(model)}</span>
          <span class="step-product-stock ${stockClass}">Stock: ${stockLabel}</span>
        </div>
        <span class="material-symbols-rounded step-category-arrow">chevron_right</span>
      </div>`;
  }).join("");

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(selectedCategory)}</h3>
      <p>${products.length} product${products.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="popup-body popup-step-body">
      <div class="step-label">
        <span class="material-symbols-rounded">inventory_2</span>
        Select a product
      </div>
      <div class="step-category-list">
        ${productCards || '<p class="no-data">No products found.</p>'}
      </div>
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// PRODUCT DETAIL POPUP (table row — product cell)
// ===================================

function openProductPopup(storeIdx) {
  const stored = popupStore[storeIdx];
  if (!stored) return;
  const row   = stored.row;
  const model = row["Product Model"] || "Product Details";
  const cat   = row["Category"]      || "";

  showPopup(`
    <div class="popup-header">
      <h3>${escHtml(model)}</h3>
      <p>${escHtml(cat)}</p>
    </div>
    <div class="popup-body">
      ${buildAllFieldsTable(row)}
    </div>
    <div class="popup-footer">
      <button class="close-btn" onclick="closePopup()">Close</button>
    </div>`);
}

// ===================================
// CONFIG HELPER
// ===================================

function getCategoryPopupConfig(viewType) {
  switch (viewType) {
    case "at":   return { data: cachedData.atStocks   || [], title: "A&T Stocks" };
    case "aver": return { data: cachedData.averStocks || [], title: "Aver Stocks" };
    default:     return { data: [], title: "Products" };
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
    btn?.addEventListener("click", (e) => { e.preventDefault(); logoutModal?.classList.add("active"); });
  });
  cancelLogoutBtn?.addEventListener("click", () => logoutModal?.classList.remove("active"));
  confirmLogoutBtn?.addEventListener("click", () => {
    allowNavigation = true;
    stopRealTimeSync();
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("userRole");
    window.location.replace("Form.html");
  });
  logoutModal?.addEventListener("click", (e) => {
    if (e.target === logoutModal) logoutModal.classList.remove("active");
  });
}