/** Demo page controls: theme switch, on/off switch, and a late DOM injection. */
(function () {
  'use strict';

  const html = document.documentElement;
  const themeButton = document.getElementById('toggle-theme');
  const enabledButton = document.getElementById('toggle-enabled');
  const injectButton = document.getElementById('inject');

  themeButton.addEventListener('click', () => {
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    // Mirror GitHub's own attribute so content.css takes the same code path.
    html.dataset.colorMode = next;
    themeButton.textContent = next === 'dark' ? 'Light theme' : 'Dark theme';
  });

  enabledButton.addEventListener('click', () => {
    const next = !window.__demo.settings.enabled;
    window.__demo.update({ enabled: next });
    enabledButton.textContent = next ? 'Turn replacements off' : 'Turn replacements on';
  });

  // --- mock hovercard ---------------------------------------------------
  // Stands in for GitHub's profile popup so the injected row and the editor
  // panel can be checked without installing the extension.

  const { usernameFromHovercardUrl } = globalThis.GHUN;
  let card = null;
  let cardTimer = null;

  function hideCard() {
    if (card) card.remove();
    card = null;
  }

  function showCard(trigger) {
    hideCard();
    const username = usernameFromHovercardUrl(trigger.getAttribute('data-hovercard-url'));
    if (!username) return;

    const rect = trigger.getBoundingClientRect();
    card = document.createElement('div');
    card.className = 'js-hovercard-content';
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.bottom + 8}px`;
    card.innerHTML =
      '<div class="Popover-message">' +
      '<div class="mock-head"><span class="mock-avatar"></span>' +
      `<span class="mock-login">${username}</span></div>` +
      '<p class="mock-bio">Engineering Manager · Tampa, Florida</p>' +
      '<p class="mock-bio">Opened this pull request</p>' +
      '</div>';
    card.addEventListener('mouseleave', hideCard);
    document.body.appendChild(card);
  }

  document.addEventListener('mouseover', (event) => {
    const trigger = event.target.closest && event.target.closest('[data-hovercard-url]');
    if (!trigger) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => showCard(trigger), 200);
  });

  document.addEventListener('mouseout', (event) => {
    const trigger = event.target.closest && event.target.closest('[data-hovercard-url]');
    if (trigger) clearTimeout(cardTimer);
  });

  let injected = 0;
  injectButton.addEventListener('click', () => {
    injected += 1;
    const comment = document.createElement('div');
    comment.className = 'comment';
    comment.innerHTML =
      '<div class="comment-head"><a href="/u1069002">u1069002</a> commented just now</div>' +
      `<div class="comment-body"><p>Late-loaded reply #${injected}, same as a hovercard or a lazy comment. cc @octocat</p></div>`;
    document.getElementById('thread').appendChild(comment);
  });
})();
