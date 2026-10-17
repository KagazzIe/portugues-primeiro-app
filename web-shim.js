// Lets the extension's pages run as an ordinary website (the phone version on GitHub Pages).
// Replaces the few Firefox extension APIs they use with web equivalents. Loaded before shared.js.

window.IS_WEB_APP = true;

(() => {
  const PREFIX = "pp:";
  const read = (key) => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const keysOf = (keys) => {
    if (keys == null) return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
    return typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  };

  window.browser = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keysOf(keys)) {
            const v = read(k);
            if (v !== undefined) out[k] = v;
          }
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) localStorage.setItem(PREFIX + k, JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of keysOf(keys)) localStorage.removeItem(PREFIX + k);
        },
      },
    },
    runtime: {
      openOptionsPage() {
        location.href = "options.html";
      },
    },
    tabs: {
      async create({ url }) {
        window.open(url, "_blank", "noopener");
      },
    },
  };

  document.documentElement.classList.add("web-app");
})();
