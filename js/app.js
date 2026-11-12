(() => {
  "use strict";

  const settings = window.SKOROCHISTO_CONFIG;
  const config = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const mobile = window.matchMedia("(max-width: 760px)");
  const menu = $("#mobile-menu");
  const toggle = $(".menu-toggle");
  const bar = $("#mobile-cta");
  const hero = $(".hero");
  const contacts = $("#contacts");
  let heroPassed = false;
  let contactsVisible = false;
  let focusDestination;

  function normalizePhone(value) {
    if (typeof value !== "string") return "";
    const raw = value.trim();
    if (!/^\+?[\d\s()\-]+$/.test(raw)) return "";
    let digits = raw.replace(/\D/g, "");
    if (raw.startsWith("+") && (digits.length !== 11 || digits[0] !== "7")) return "";
    if (digits.length === 10 && /^[2-9]/.test(digits)) digits = `7${digits}`;
    if (digits.length === 11 && digits[0] === "8") digits = `7${digits.slice(1)}`;
    return /^7[2-9]\d{9}$/.test(digits) ? `+${digits}` : "";
  }

  // The verified static HTML remains usable if settings or JavaScript fail to load.
  const phone = normalizePhone(config.phone);
  if (phone) {
    const digits = phone.slice(2);
    const label = `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`;
    $$("[data-call], [data-phone]").forEach((link) => {
      const action = link.hasAttribute("data-phone") ? "Позвонить" : link.textContent.trim();
      link.href = `tel:${phone}`;
      link.setAttribute("aria-label", `${action} по номеру ${label}`);
      if (link.hasAttribute("data-phone")) link.textContent = label;
    });
  }
  [["[data-contact-area]", config.area], ["[data-contact-hours]", config.hours]].forEach(([selector, value]) => {
    if (typeof value !== "string" || !value.trim()) return;
    $$(selector).forEach((element) => { element.textContent = value.trim(); });
  });

  function updateStickyAction() {
    if (!bar) return;
    const visible = mobile.matches && heroPassed && !contactsVisible && !menu?.open;
    bar.hidden = !mobile.matches;
    bar.classList.toggle("is-visible", visible);
    bar.inert = !visible;
  }

  function syncMenu() {
    toggle?.setAttribute("aria-expanded", String(!!menu?.open));
    document.body.classList.toggle("dialog-open", !!menu?.open);
    updateStickyAction();
  }

  function closeMenu(destination) {
    if (!menu?.open) return;
    focusDestination = destination || toggle;
    menu.close();
    syncMenu();
  }

  if (toggle && typeof menu?.showModal === "function") {
    document.documentElement.classList.add("has-js");
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      if (menu.open) return;
      focusDestination = null;
      menu.showModal();
      syncMenu();
    });
    menu.addEventListener("cancel", (event) => { event.preventDefault(); closeMenu(); });
    menu.addEventListener("close", () => {
      syncMenu();
      if (menu.open) return;
      const destination = focusDestination || toggle;
      focusDestination = null;
      if (!destination?.isConnected || !destination.getClientRects().length) return;
      if (!destination.matches("a[href], button, [tabindex]")) destination.setAttribute("tabindex", "-1");
      destination.focus({ preventScroll: true });
    });
    menu.addEventListener("click", (event) => {
      if (event.target.closest("[data-dialog-close]")) { closeMenu(); return; }
      if (event.target === menu) {
        const rect = menu.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMenu();
        return;
      }
      const link = event.target.closest("a[href]");
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href, location.href);
      const samePage = url.origin === location.origin && url.pathname === location.pathname && url.search === location.search;
      const destination = samePage && url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
      closeMenu(destination);
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
      const controls = $$("a[href], button", menu).filter((control) => !control.disabled && control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  function updateFromScroll() {
    heroPassed = !!hero && hero.getBoundingClientRect().bottom < 80;
    const rect = contacts?.getBoundingClientRect();
    contactsVisible = !!rect && rect.top < window.innerHeight && rect.bottom > 80;
    updateStickyAction();
  }

  mobile.addEventListener("change", () => {
    if (!mobile.matches) closeMenu($(".brand"));
    updateFromScroll();
  });

  if (hero && contacts && bar) {
    if (typeof window.IntersectionObserver === "function") {
      new IntersectionObserver((entries) => {
        heroPassed = entries[0].boundingClientRect.bottom < 80;
        updateStickyAction();
      }, { rootMargin: "-80px 0px 0px 0px", threshold: 0 }).observe(hero);
      new IntersectionObserver((entries) => {
        contactsVisible = entries[0].isIntersecting;
        updateStickyAction();
      }, { rootMargin: "-80px 0px 0px 0px", threshold: 0 }).observe(contacts);
    } else {
      let scheduled = false;
      const scheduleUpdate = () => {
        if (scheduled) return;
        scheduled = true;
        window.requestAnimationFrame(() => { scheduled = false; updateFromScroll(); });
      };
      window.addEventListener("scroll", scheduleUpdate, { passive: true });
      window.addEventListener("resize", scheduleUpdate, { passive: true });
    }
  }
  updateFromScroll();
})();
