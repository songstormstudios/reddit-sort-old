/**
 * Reddit Sort by Old — Content Script
 *
 * Adds a "Sort: Old" button to subreddit pages on both old and new Reddit.
 * When activated, fetches posts via Reddit's public JSON API, sorts them
 * by creation date ascending, and replaces the listing in page.
 */

(function () {
  "use strict";

  // Avoid double-injection
  if (window.__redditSortOldInjected) return;
  window.__redditSortOldInjected = true;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Return the subreddit name from the current URL, or null. */
  function getSubreddit() {
    const match = location.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
    return match ? match[1] : null;
  }

  /** True when we're on old.reddit.com OR using old-design on www */
  function isOldReddit() {
    return (
      location.hostname === "old.reddit.com" ||
      // Old design served on www via user prefs — detect by DOM
      !!document.querySelector("#header, body.listing-page, #siteTable")
    );
  }

  /** True when we're on the 2023+ shreddit redesign */
  function isNewReddit() {
    return !isOldReddit();
  }

  /** Return the base URL prefix for links (old vs new Reddit) */
  function redditBase() {
    return isOldReddit() ? "https://old.reddit.com" : "https://www.reddit.com";
  }

  /** Format a unix timestamp into a readable relative-time string. */
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

  /** Format a number like 12345 → "12.3k" */
  function formatScore(n) {
    if (n >= 100000) return (n / 1000).toFixed(0) + "k";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  /** Sanitize a string for safe insertion into HTML */
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Reddit JSON API fetcher — listing + Pullpush for unlimited deep history
  // ---------------------------------------------------------------------------

  const API_ORIGIN = location.origin;
  const API_LIMIT = 100;
  const PULLPUSH_BASE = "https://api.pullpush.io/reddit/search/submission/";

  /** Fetch one page from a subreddit listing (e.g. /new). Always works. */
  async function fetchListingPage(subreddit, after) {
    const url = new URL(`${API_ORIGIN}/r/${encodeURIComponent(subreddit)}/new.json`);
    url.searchParams.set("limit", String(API_LIMIT));
    url.searchParams.set("raw_json", "1");
    if (after) url.searchParams.set("after", after);

    const resp = await fetch(url.toString(), { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`Reddit API error: ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch one page from Pullpush (Pushshift successor).
   * Returns posts sorted ascending by created_utc.
   * `afterEpoch` = only posts created after this unix timestamp.
   */
  async function fetchPullpushPage(subreddit, afterEpoch) {
    const url = new URL(PULLPUSH_BASE);
    url.searchParams.set("subreddit", subreddit);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("sort_type", "created_utc");
    url.searchParams.set("size", String(API_LIMIT));
    if (afterEpoch != null) url.searchParams.set("after", String(afterEpoch));

    const resp = await fetch(url.toString());
    if (!resp.ok) return null; // Pullpush unavailable
    const json = await resp.json();
    return json?.data ?? null;
  }

  /**
   * Phase 1: paginate through /new listing (~1000 posts max).
   * This is the reliable baseline that always works.
   */
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
          posts.push(p);
        }
      }

      after = json?.data?.after;
      if (!after) break;
      await sleep(200);
    }
  }

  /**
   * Phase 2: use the Pullpush (Pushshift) API to fetch ALL historical posts.
   * Pullpush serves an archive of Reddit with no pagination cap.
   * Walks forward from epoch=0 in ascending order.
   * Returns false if Pullpush is unavailable.
   */
  async function fetchViaPullpush(subreddit, seen, posts, onProgress) {
    let afterEpoch = 0;
    const maxPages = 500; // 500 pages × 100 = up to 50k posts

    for (let page = 0; page < maxPages; page++) {
      if (onProgress) {
        onProgress(
          posts.length,
          `Loading full history… page ${page + 1} (${posts.length} posts so far)`
        );
      }

      const items = await fetchPullpushPage(subreddit, afterEpoch);
      if (items === null) return false; // API unavailable
      if (items.length === 0) break;    // no more posts

      let newestEpoch = afterEpoch;
      for (const p of items) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          posts.push(p);
        }
        if (p.created_utc > newestEpoch) {
          newestEpoch = p.created_utc;
        }
      }

      // If the newest epoch didn't advance, we're stuck — stop
      if (newestEpoch <= afterEpoch) break;
      afterEpoch = newestEpoch;

      await sleep(500); // Pullpush asks for ≤2 req/sec
    }

    return true;
  }

  /**
   * Main entry: combines listing + Pullpush to fetch as many posts as possible,
   * sorted oldest-first.
   */
  async function fetchOldestPosts(subreddit, onProgress) {
    const seen = new Set();
    const posts = [];

    // Phase 1 — Pullpush archive: gets ALL posts, oldest-first, no cap
    const pullpushWorked = await fetchViaPullpush(subreddit, seen, posts, onProgress);

    // Phase 2 — Reddit listing: fills in very recent posts that Pullpush
    // may not have indexed yet (it can lag by hours/days)
    if (onProgress) {
      onProgress(posts.length, `Fetching latest posts from Reddit…`);
    }
    await fetchViaListing(subreddit, seen, posts, onProgress);

    if (!pullpushWorked && onProgress) {
      onProgress(
        posts.length,
        `Loaded ${posts.length} posts (archive API unavailable, showing Reddit listing only)`
      );
    }

    posts.sort((a, b) => a.created_utc - b.created_utc);
    return posts;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // UI — Old Reddit
  // ---------------------------------------------------------------------------

  function injectOldReddit(subreddit) {
    // Find the sort menu tabs
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
      // Deactivate other tabs, activate ours
      tabMenu.querySelectorAll(".selected").forEach((el) => {
        el.classList.remove("selected");
      });
      li.classList.add("selected");
      activateSort(subreddit);
    });
    li.appendChild(a);
    tabMenu.appendChild(li);
  }

  // ---------------------------------------------------------------------------
  // UI — New Reddit (2023+ shreddit redesign)
  // ---------------------------------------------------------------------------

  function injectNewReddit(subreddit) {
    // Wait for the sort dropdown or the feed nav to appear
    const tryInject = () => {
      // Look for the sort bar — it lives in various containers depending on redesign iteration
      const sortBar =
        document.querySelector("shreddit-sort-dropdown") ||
        document.querySelector("[slot='sort-options']") ||
        document.querySelector("#t3_sort") ||
        document.querySelector("div[data-testid='frontpage-sort-menu']") ||
        document.querySelector(".post-list-header") ||
        document.querySelector("header ~ div:has(> [role='navigation'])");

      // Fallback: put button at the top of the main feed
      const feedContainer =
        document.querySelector("shreddit-feed") ||
        document.querySelector("[data-testid='posts-list']") ||
        document.querySelector("div.rpBJOHq2PR60pnRJlULSm") ||
        document.querySelector("main");

      const target = sortBar || feedContainer;
      if (!target || target.querySelector(".rso-sort-old-btn")) return;

      const btn = document.createElement("button");
      btn.className = "rso-sort-old-btn";
      btn.textContent = "⏳ Sort: Oldest";
      btn.title = "Sort subreddit posts oldest → newest (extension)";
      btn.addEventListener("click", () => activateSort(subreddit));

      if (sortBar) {
        sortBar.parentElement.insertBefore(btn, sortBar.nextSibling);
      } else {
        target.prepend(btn);
      }
    };

    // Retry a few times because new Reddit renders lazily
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

  // ---------------------------------------------------------------------------
  // Sorting activation
  // ---------------------------------------------------------------------------

  let isLoading = false;

  async function activateSort(subreddit) {
    if (isLoading) return;
    isLoading = true;

    // Show overlay
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

  // ---------------------------------------------------------------------------
  // Render sorted posts
  // ---------------------------------------------------------------------------

  function renderSortedPosts(posts, subreddit) {
    const onOld = isOldReddit();

    // Find the main content area and replace it
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

    // Build custom HTML listing
    const wrapper = document.createElement("div");
    wrapper.className = "rso-results" + (onOld ? " rso-old-reddit" : "");
    wrapper.innerHTML = `
      <div class="rso-results-header">
        <h2>r/${escapeHtml(subreddit)} — Sorted by Oldest</h2>
        <p>${posts.length} posts loaded (oldest → newest).</p>
        <button class="rso-restore-btn" title="Restore original Reddit view">✕ Restore original view</button>
      </div>
      <div class="rso-post-list">
        ${posts.map((p, i) => postCard(p, i)).join("")}
      </div>
    `;

    wrapper.querySelector(".rso-restore-btn").addEventListener("click", () => {
      location.reload();
    });

    // Store original content and replace
    container.dataset.rsoOriginalDisplay = container.style.display || "";
    container.style.display = "none";

    // On old Reddit also hide the pagination nav and "next" buttons
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
    // Pullpush may set permalink or full_link; Reddit listing always has permalink
    const permaPath = post.permalink || `/r/${encodeURIComponent(post.subreddit)}/comments/${post.id}/`;
    const permalink = permaPath.startsWith("http") ? permaPath : `${base}${permaPath}`;
    const url = post.url || permalink;
    const isSelf = post.is_self;
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
            ${!isSelf ? `&middot; <a class="rso-domain" href="${escapeHtml(url)}" target="_blank" rel="noopener">(${escapeHtml(post.domain || "")})</a>` : ""}
          </div>
        </div>
      </article>
    `;
  }

  // ---------------------------------------------------------------------------
  // Loading overlay
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // SPA navigation support (new Reddit uses client-side routing)
  // ---------------------------------------------------------------------------

  function onUrlChange() {
    const sub = getSubreddit();
    if (!sub) return;

    if (isOldReddit()) {
      injectOldReddit(sub);
    } else {
      injectNewReddit(sub);
    }
  }

  // Observe URL changes for SPA navigation
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onUrlChange();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial injection
  onUrlChange();
})();
