// Role-aware desktop/mobile navigation menu behavior.

const MOBILE_TAB_GROUPS = {
  learn: new Set(['library', 'sparring', 'training']),
  progress: new Set(['history', 'dashboard']),
  more: new Set(['growth-lab', 'neuralwiki', 'debate', 'classchat', 'hrd-program', 'enterprise', 'admin']),
};

const NAVIGATION_MENUS = [
  { menuId: 'desktop-more-menu', triggerId: 'desktop-more-btn' },
  { menuId: 'mobile-more-menu', triggerId: 'mobile-more-btn' },
];

function getMenuParts(menuId, triggerId) {
  return {
    menu: document.getElementById(menuId),
    trigger: document.getElementById(triggerId),
  };
}

function firstFocusable(menu) {
  return menu.querySelector(
    'button:not([hidden]):not([aria-hidden="true"]):not([disabled]), [href]:not([hidden]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"]):not([hidden]):not([aria-hidden="true"])',
  );
}

function setNavigationMenuOpen(menuId, triggerId, open, returnFocus = false) {
  const { menu, trigger } = getMenuParts(menuId, triggerId);
  if (!menu || !trigger) return false;

  if (open) {
    NAVIGATION_MENUS.forEach((entry) => {
      if (entry.menuId !== menuId) {
        setNavigationMenuOpen(entry.menuId, entry.triggerId, false, false);
      }
    });
  }

  menu.hidden = !open;
  menu.setAttribute('aria-hidden', open ? 'false' : 'true');
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    window.requestAnimationFrame(() => firstFocusable(menu)?.focus());
  } else if (returnFocus) {
    window.requestAnimationFrame(() => trigger.focus());
  }
  return true;
}

function toggleDesktopMore() {
  const { menu } = getMenuParts('desktop-more-menu', 'desktop-more-btn');
  if (!menu) return false;
  return setNavigationMenuOpen('desktop-more-menu', 'desktop-more-btn', menu.hidden, false);
}

function closeDesktopMore(returnFocus = false) {
  return setNavigationMenuOpen('desktop-more-menu', 'desktop-more-btn', false, returnFocus);
}

function toggleMobileMore() {
  const { menu } = getMenuParts('mobile-more-menu', 'mobile-more-btn');
  if (!menu) return false;
  return setNavigationMenuOpen('mobile-more-menu', 'mobile-more-btn', menu.hidden, false);
}

function closeMobileMore(returnFocus = false) {
  return setNavigationMenuOpen('mobile-more-menu', 'mobile-more-btn', false, returnFocus);
}

function closeAllNavigationMenus(returnFocus = false) {
  NAVIGATION_MENUS.forEach((entry) => {
    const { menu } = getMenuParts(entry.menuId, entry.triggerId);
    if (menu && !menu.hidden) {
      setNavigationMenuOpen(entry.menuId, entry.triggerId, false, returnFocus);
    }
  });
}

function updateMobileNavActive(tab) {
  const activeTab = String(tab || '');
  document.querySelectorAll('.mobile-nav-btn[data-mobile-group]').forEach((button) => {
    const group = button.dataset.mobileGroup;
    const active = Boolean(MOBILE_TAB_GROUPS[group]?.has(activeTab));
    button.classList.toggle('active', active);
    if (active && group !== 'more') button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  document.querySelectorAll('#mobile-more-menu [data-tab]').forEach((button) => {
    const active = button.dataset.tab === activeTab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function eventIsInsideMenu(event, menu, trigger) {
  return menu.contains(event.target) || trigger.contains(event.target);
}

function initMobileNav() {
  const mobileNav = document.getElementById('mobile-bottom-nav');
  const mainApp = document.getElementById('main-app');
  if (!mobileNav || !mainApp) return;

  const observer = new MutationObserver(() => {
    mobileNav.style.display = mainApp.style.display !== 'none' ? '' : 'none';
  });
  observer.observe(mainApp, { attributes: true, attributeFilter: ['style'] });

  document.addEventListener('click', (event) => {
    NAVIGATION_MENUS.forEach((entry) => {
      const { menu, trigger } = getMenuParts(entry.menuId, entry.triggerId);
      if (menu && trigger && !menu.hidden && !eventIsInsideMenu(event, menu, trigger)) {
        const returnFocus = menu.contains(document.activeElement);
        setNavigationMenuOpen(entry.menuId, entry.triggerId, false, returnFocus);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const hasOpenMenu = NAVIGATION_MENUS.some((entry) => {
      const { menu } = getMenuParts(entry.menuId, entry.triggerId);
      return Boolean(menu && !menu.hidden);
    });
    if (hasOpenMenu) {
      event.preventDefault();
      closeAllNavigationMenus(true);
      return;
    }
    if (document.getElementById('dashboard-sidebar')?.classList.contains('mobile-open')) {
      event.preventDefault();
      window.closeMobileDashboard?.(true);
    }
  });
}

export {
  initMobileNav,
  updateMobileNavActive,
  toggleDesktopMore,
  closeDesktopMore,
  toggleMobileMore,
  closeMobileMore,
  closeAllNavigationMenus,
};

if (typeof window !== 'undefined') {
  Object.assign(window, {
    initMobileNav,
    updateMobileNavActive,
    toggleDesktopMore,
    closeDesktopMore,
    toggleMobileMore,
    closeMobileMore,
  });
}
