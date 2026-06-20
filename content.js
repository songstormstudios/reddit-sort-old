(function () {
  "use strict";

  if (window.__redditSortOldInjected) return;
  window.__redditSortOldInjected = true;

  function getSubreddit() {
    const match = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
    return match ? match[1] : null;
  }

  function isOldReddit() {
    return (
      location.hostname === "old.reddit.com" ||
      !!document.querySelector("#header, body.listing-page, #siteTable")
    );
  }

  function isNewReddit() {
    return !isOldReddit();
  }

  function redditBase() {
    return isOldReddit() ? "https://old.reddit.com" : "https://www.reddit.com";
  }

  function timeAgo(epochSeconds) {
    const seconds = Math.floor(Date.now() / 1000 - epochSeconds);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  }

  function formatScore(n) {
    if (n >= 100000) return (n / 1000).toFixed(0) + "k";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  const API_ORIGIN = location.origin;
  const API_LIMIT = 100;
  const MAX_POSTS = 1000000;
  const RENDER_CHUNK = 250;
  const ARCTIC_SHIFT_BASE = "https://arctic-shift.photon-reddit.com/api/posts/search";
  const PULLPUSH_BASE = "https://api.pullpush.io/reddit/search/submission/";

  const POST_FIELDS = [
    "id",
    "title",
    "author",
    "created_utc",
    "permalink",
    "url",
    "is_self",
    "thumbnail",
    "num_comments",
    "score",
    "link_flair_text",
    "over_18",
    "domain",
    "subreddit",
  ];

  const ARCTIC_FIELDS = [
    "id",
    "title",
    "author",
    "created_utc",
    "url",
    "num_comments",
    "score",
    "link_flair_text",
    "over_18",
    "subreddit",
  ];

  function slimPost(p) {
    const slim = {};
    for (const f of POST_FIELDS) {
      if (p[f] != null) slim[f] = p[f];
    }
    return slim;
  }

  async function fetchListingPage(subreddit, after) {
    const url = new URL(`${API_ORIGIN}/r/${encodeURIComponent(subreddit)}/new.json`);
    url.searchParams.set("limit", String(API_LIMIT));
    url.searchParams.set("raw_json", "1");
    if (after) url.searchParams.set("after", after);

    const resp = await fetch(url.toString(), { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`Reddit API error: ${resp.status}`);
    return resp.json();
  }

  let arcticAutoSupported = true;

  async function fetchArcticShiftPage(subreddit, afterEpoch) {
    try {
      const url = new URL(ARCTIC_SHIFT_BASE);
      url.searchParams.set("subreddit", subreddit);
      url.searchParams.set("sort", "asc");
      if (arcticAutoSupported) {
        url.searchParams.set("limit", "auto");
        url.searchParams.set("fields", ARCTIC_FIELDS.join(","));
      } else {
        url.searchParams.set("limit", String(API_LIMIT));
      }
      if (afterEpoch != null && afterEpoch > 0) url.searchParams.set("after", String(afterEpoch));

      const resp = await fetch(url.toString());
      if (!resp.ok) {
        if (arcticAutoSupported && resp.status >= 400 && resp.status < 500) {
          arcticAutoSupported = false;
          return fetchArcticShiftPage(subreddit, afterEpoch);
        }
        return null;
      }
      const json = await resp.json();
      return json?.data ?? null;
    } catch {
      return null;
    }
  }

  async function fetchPullpushPage(subreddit, afterEpoch) {
    try {
      const url = new URL(PULLPUSH_BASE);
      url.searchParams.set("subreddit", subreddit);
      url.searchParams.set("sort", "asc");
      url.searchParams.set("sort_type", "created_utc");
      url.searchParams.set("size", String(API_LIMIT));
      if (afterEpoch != null) url.searchParams.set("after", String(afterEpoch));

      const resp = await fetch(url.toString());
      if (!resp.ok) return null;
      const json = await resp.json();
      return json?.data ?? null;
    } catch {
      return null;
    }
  }

  async function fetchArchivePage(subreddit, afterEpoch) {
    const result = await fetchArcticShiftPage(subreddit, afterEpoch);
    if (result !== null) return result;
    return await fetchPullpushPage(subreddit, afterEpoch);
  }

  async function fetchViaListing(subreddit, seen, posts, onProgress) {
    let after = null;
    const maxPages = 10;

    for (let page = 0; page < maxPages; page++) {
      if (onProgress) {
        onProgress(posts.length, `Fetching newest posts… page ${page + 1}`);
      }

      const json = await fetchListingPage(subreddit, after);
      const children = json?.data?.children ?? [];
      if (children.length === 0) break;

      for (const child of children) {
        const p = child.data;
        if (!seen.has(p.id)) {
          seen.add(p.id);
          posts.push(slimPost(p));
        }
      }

      if (posts.length >= MAX_POSTS) break;
      after = json?.data?.after;
      if (!after) break;
      await sleep(200);
    }
  }

  async function fetchViaArchive(subreddit, seen, posts, onProgress) {
    let afterEpoch = 0;
    const maxPages = Math.ceil(MAX_POSTS / API_LIMIT);
    let consecutiveFailures = 0;

    for (let page = 0; page < maxPages && posts.length < MAX_POSTS; page++) {
      if (onProgress) {
        onProgress(
          posts.length,
          `Loading full history… ${posts.length.toLocaleString()} posts so far`
        );
      }

      const items = await fetchArchivePage(subreddit, afterEpoch);
      if (items === null) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) return false;
        await sleep(1000);
        continue;
      }
      consecutiveFailures = 0;
      if (items.length === 0) break;

      let newestEpoch = afterEpoch;
      for (const p of items) {
        if (!seen.has(p.id) && posts.length < MAX_POSTS) {
          seen.add(p.id);
          posts.push(slimPost(p));
        }
        if (p.created_utc > newestEpoch) {
          newestEpoch = p.created_utc;
        }
      }

      if (newestEpoch <= afterEpoch) break;
      afterEpoch = newestEpoch;

      await sleep(100);
    }

    return true;
  }

  async function fetchOldestPosts(subreddit, onProgress) {
    const seen = new Set();
    const posts = [];

    const archiveWorked = await fetchViaArchive(subreddit, seen, posts, onProgress);

    if (posts.length < MAX_POSTS) {
      if (onProgress) {
        onProgress(posts.length, `Fetching latest posts from Reddit…`);
      }
      await fetchViaListing(subreddit, seen, posts, onProgress);
    }

    if (!archiveWorked && onProgress) {
      onProgress(
        posts.length,
        `Loaded ${posts.length} posts (archive APIs unavailable, showing Reddit listing only)`
      );
    }

    posts.sort((a, b) => a.created_utc - b.created_utc);
    return posts;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function injectOldReddit(subreddit) {
    const tabMenu = document.querySelector(".tabmenu");
    if (!tabMenu || tabMenu.querySelector(".rso-sort-old-tab")) return;

    const li = document.createElement("li");
    li.className = "rso-sort-old-tab";
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = "oldest";
    a.title = "Sort by oldest posts first (Reddit Sort Old extension)";
    a.className = "choice";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      tabMenu.querySelectorAll(".selected").forEach((el) => {
        el.classList.remove("selected");
      });
      li.classList.add("selected");
      activateSort(subreddit);
    });
    li.appendChild(a);
    tabMenu.appendChild(li);
  }

  function injectNewReddit(subreddit) {
    const tryInject = () => {
      const sortBar =
        document.querySelector("shreddit-sort-dropdown") ||
        document.querySelector("[slot='sort-options']") ||
        document.querySelector("#t3_sort") ||
        document.querySelector("div[data-testid='frontpage-sort-menu']") ||
        document.querySelector(".post-list-header") ||
        document.querySelector("header ~ div:has(> [role='navigation'])");

      const feedContainer =
        document.querySelector("shreddit-feed") ||
        document.querySelector("[data-testid='posts-list']") ||
        document.querySelector("div.rpBJOHq2PR60pnRJlULSm") ||
        document.querySelector("main");

      const existingButtons = Array.from(document.querySelectorAll(".rso-sort-old-btn"));
      const btn = existingButtons.shift() || document.createElement("button");
      existingButtons.forEach((extraBtn) => {
        extraBtn.remove();
      });

      const target = sortBar || feedContainer;
      if (!target) return;

      btn.type = "button";
      btn.className = "rso-sort-old-btn";
      btn.textContent = "\u23f3 Sort: Oldest";
      btn.title = "Sort subreddit posts oldest to newest (extension)";
      btn.onclick = () => activateSort(subreddit);

      if (sortBar && sortBar.parentElement) {
        if (sortBar.nextSibling !== btn) {
          sortBar.parentElement.insertBefore(btn, sortBar.nextSibling);
        }
      } else if (target.firstChild !== btn) {
        target.prepend(btn);
      }
    };

    let attempts = 0;
    const interval = setInterval(() => {
      tryInject();
      attempts++;
      if (document.querySelector(".rso-sort-old-btn") || attempts > 20) {
        clearInterval(interval);
      }
    }, 500);
    tryInject();
  }

  let isLoading = false;

  async function activateSort(subreddit) {
    if (isLoading) return;
    isLoading = true;

    showOverlay("Fetching posts…");

    try {
      const posts = await fetchOldestPosts(subreddit, (count, status) => {
        updateOverlayText(status || `Fetching posts… (${count} so far)`);
      });

      if (posts.length === 0) {
        updateOverlayText("No posts found.");
        setTimeout(hideOverlay, 1500);
        return;
      }

      renderSortedPosts(posts, subreddit);
      hideOverlay();
    } catch (err) {
      console.error("[Reddit Sort Old]", err);
      updateOverlayText(`Error: ${err.message}`);
      setTimeout(hideOverlay, 3000);
    } finally {
      isLoading = false;
    }
  }

  function renderSortedPosts(posts, subreddit) {
    const onOld = isOldReddit();

    const container = onOld
      ? document.querySelector("#siteTable")
      : document.querySelector("shreddit-feed") ||
        document.querySelector("[data-testid='posts-list']") ||
        document.querySelector("div.rpBJOHq2PR60pnRJlULSm") ||
        document.querySelector("main .ListingLayout-outerContainer") ||
        document.querySelector("main");

    if (!container) {
      console.error("[Reddit Sort Old] Could not find post container");
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "rso-results" + (onOld ? " rso-old-reddit" : "");
    wrapper.innerHTML = `
      <div class="rso-results-header">
        <h2>r/${escapeHtml(subreddit)} — Sorted by Oldest</h2>
        <p class="rso-results-count"></p>
        <button class="rso-restore-btn" title="Restore original Reddit view">✕ Restore original view</button>
      </div>
      <div class="rso-post-list"></div>
      <div class="rso-load-sentinel"></div>
    `;

    wrapper.querySelector(".rso-restore-btn").addEventListener("click", () => {
      location.reload();
    });

    const listEl = wrapper.querySelector(".rso-post-list");
    const countEl = wrapper.querySelector(".rso-results-count");
    const sentinel = wrapper.querySelector(".rso-load-sentinel");
    let rendered = 0;

    function updateCount() {
      countEl.textContent =
        `${posts.length.toLocaleString()} posts loaded (oldest → newest), ` +
        `showing ${rendered.toLocaleString()}.`;
    }

    function renderChunk() {
      if (rendered >= posts.length) return;
      const end = Math.min(rendered + RENDER_CHUNK, posts.length);
      let html = "";
      for (let i = rendered; i < end; i++) {
        html += postCard(posts[i], i);
      }
      listEl.insertAdjacentHTML("beforeend", html);
      rendered = end;
      updateCount();
      if (rendered >= posts.length) {
        chunkObserver.disconnect();
        sentinel.remove();
      }
    }

    const chunkObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) renderChunk();
      },
      { rootMargin: "1500px" }
    );
    chunkObserver.observe(sentinel);

    renderChunk();

    container.dataset.rsoOriginalDisplay = container.style.display || "";
    container.style.display = "none";

    if (onOld) {
      const nav = document.querySelector(".nav-buttons");
      if (nav) {
        nav.dataset.rsoOriginalDisplay = nav.style.display || "";
        nav.style.display = "none";
      }
    }

    container.parentElement.insertBefore(wrapper, container);
  }

  function postCard(post, index) {
    const base = redditBase();
    const permaPath = post.permalink || `/r/${encodeURIComponent(post.subreddit)}/comments/${post.id}/`;
    const permalink = permaPath.startsWith("http") ? permaPath : `${base}${permaPath}`;
    const url = post.url || permalink;
    const isSelf =
      post.is_self != null
        ? post.is_self
        : !post.url || post.url.includes(`/comments/${post.id}`);
    let domain = post.domain;
    if (!domain && !isSelf) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }
    }
    const thumbnail =
      post.thumbnail && post.thumbnail.startsWith("http") ? post.thumbnail : null;
    const numComments = post.num_comments ?? "?";
    const score = post.score ?? 0;

    const date = new Date(post.created_utc * 1000);
    const dateStr = date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const flairHtml = post.link_flair_text
      ? `<span class="rso-flair">${escapeHtml(post.link_flair_text)}</span>`
      : "";

    const nsfwBadge = post.over_18
      ? `<span class="rso-nsfw">NSFW</span>`
      : "";

    const thumbnailHtml = thumbnail
      ? `<img class="rso-thumb" src="${escapeHtml(thumbnail)}" alt="" loading="lazy" />`
      : `<div class="rso-thumb rso-thumb-placeholder"></div>`;

    return `
      <article class="rso-post" data-index="${index}">
        <div class="rso-post-score">
          <span class="rso-score" title="${score} points">${formatScore(score)}</span>
        </div>
        ${thumbnailHtml}
        <div class="rso-post-body">
          <a class="rso-post-title" href="${escapeHtml(permalink)}" target="_blank" rel="noopener">
            ${nsfwBadge}${flairHtml}${escapeHtml(post.title)}
          </a>
          <div class="rso-post-meta">
            <span title="${date.toISOString()}">${dateStr} (${timeAgo(post.created_utc)})</span>
            &middot; by <a href="${base}/user/${encodeURIComponent(post.author)}" target="_blank" rel="noopener">u/${escapeHtml(post.author)}</a>
            &middot; <a href="${escapeHtml(permalink)}" target="_blank" rel="noopener">${numComments} comments</a>
            ${!isSelf ? `&middot; <a class="rso-domain" href="${escapeHtml(url)}" target="_blank" rel="noopener">(${escapeHtml(domain || "")})</a>` : ""}
          </div>
        </div>
      </article>
    `;
  }

  let overlayEl = null;

  function showOverlay(text) {
    if (overlayEl) {
      overlayEl.remove();
    }
    overlayEl = document.createElement("div");
    overlayEl.className = "rso-overlay";
    overlayEl.innerHTML = `
      <div class="rso-overlay-box">
        <div class="rso-spinner"></div>
        <p class="rso-overlay-text">${escapeHtml(text)}</p>
      </div>
    `;
    document.body.appendChild(overlayEl);
  }

  function updateOverlayText(text) {
    const el = document.querySelector(".rso-overlay-text");
    if (el) el.textContent = text;
  }

  function hideOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  function onUrlChange() {
    const sub = getSubreddit();
    if (!sub) return;

    if (isOldReddit()) {
      injectOldReddit(sub);
    } else {
      injectNewReddit(sub);
    }
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onUrlChange();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  onUrlChange();
})();
