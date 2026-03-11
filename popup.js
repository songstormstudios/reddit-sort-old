(function () {
  "use strict";

  const statusEl = document.getElementById("status");

  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (tab && tab.url && /reddit\.com\/r\//.test(tab.url)) {
      statusEl.textContent = "✓ Active on this subreddit";
      statusEl.classList.add("active");
    } else {
      statusEl.textContent = "Navigate to a subreddit to use";
      statusEl.classList.add("inactive");
    }
  });
})();
