const frame = document.querySelector("#lab-frame");
const status = document.querySelector("#viewer-status");

if (frame && status) {
  const original = new URL(frame.getAttribute("src"), window.location.href);
  const labPath = original.pathname.match(/^\/lab-\d{2}\//)?.[0];
  const pages = new Map();
  let cleanup = () => {};

  try {
    for (const [path, destination] of Object.entries(JSON.parse(frame.dataset.pages || "{}"))) {
      const target = new URL(destination, window.location.href);
      if (labPath && path.startsWith(labPath)
          && target.origin === window.location.origin
          && target.pathname.startsWith(`/view${labPath}`)) {
        pages.set(path, target);
      }
    }
  } catch {
    // The lab remains usable if its optional page navigation is unavailable.
  }

  function showUnavailable() {
    status.hidden = false;
    const link = document.createElement("a");
    link.href = original.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Открыть отдельно";
    status.replaceChildren("Не удалось показать работу. ", link);
  }

  function connectFrame() {
    cleanup();
    try {
      const doc = frame.contentDocument;
      const child = frame.contentWindow;
      if (!doc?.body || !labPath || doc.location.origin !== window.location.origin
          || !doc.location.pathname.startsWith(labPath)) {
        showUnavailable();
        return;
      }

      let pending = 0;
      function resize() {
        pending = 0;
        const body = doc.body;
        const box = body.getBoundingClientRect();
        const marginBottom = parseFloat(child.getComputedStyle(body).marginBottom) || 0;
        // The root scrollHeight includes the iframe viewport and cannot shrink with the content.
        const bottom = box.top + child.scrollY
          + Math.max(box.height, body.offsetHeight, body.scrollHeight) + marginBottom;
        const height = Math.max(300, Math.min(20000, Math.ceil(bottom)));
        if (frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
      }
      function scheduleResize() {
        if (!pending) pending = window.requestAnimationFrame(resize);
      }
      function navigate(event) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
            || event.shiftKey || event.altKey) return;
        const anchor = event.target.closest?.("a[href]");
        if (!anchor || anchor.hasAttribute("download")
            || (anchor.target && anchor.target !== "_self")) return;
        const target = new URL(anchor.getAttribute("href"), doc.location.href);
        if (!["http:", "https:"].includes(target.protocol)) return;
        if (target.origin !== window.location.origin) {
          event.preventDefault();
          window.open(target.href, "_blank", "noopener,noreferrer");
          return;
        }
        if (target.pathname === doc.location.pathname && target.hash) return;
        const destination = pages.get(target.pathname);
        if (destination) {
          event.preventDefault();
          const next = new URL(destination);
          next.search = target.search;
          next.hash = target.hash;
          window.location.assign(next.href);
        }
      }

      const observer = new ResizeObserver(scheduleResize);
      observer.observe(doc.body);
      doc.addEventListener("click", navigate);
      doc.addEventListener("load", scheduleResize, true);
      window.addEventListener("resize", scheduleResize);
      cleanup = () => {
        observer.disconnect();
        window.cancelAnimationFrame(pending);
        doc.removeEventListener("click", navigate);
        doc.removeEventListener("load", scheduleResize, true);
        window.removeEventListener("resize", scheduleResize);
      };
      status.hidden = true;
      resize();
    } catch {
      cleanup();
      showUnavailable();
    }
  }

  frame.addEventListener("load", connectFrame);
  frame.addEventListener("error", showUnavailable);
  if (frame.contentDocument?.readyState === "complete"
      && frame.contentDocument.URL !== "about:blank") connectFrame();
}
