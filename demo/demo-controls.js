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

  // --- mock quote reply -------------------------------------------------
  // The one behaviour on this page that can't be checked by looking at it.
  // GitHub builds a quote out of the comment's own DOM rather than out of the
  // markdown it was written in, so if the replacement name were page text this
  // would paste it into the reply — and GitHub would resolve the first word of
  // it as a mention of whoever owns that account. This is the shape of what
  // they do: read the text out, prefix every line with "> ".

  const quoteButton = document.getElementById('quote');
  const quoteOut = document.getElementById('quote-out');

  quoteButton.addEventListener('click', () => {
    const bodies = document.querySelectorAll('#thread .comment-body');
    const text = bodies[bodies.length - 1].textContent.trim().replace(/\s*\n\s*/g, '\n');
    // Rendered in a <pre>, which the engine skips — so what you read here is
    // exactly the text that would be submitted.
    quoteOut.textContent = `> ${text.replace(/\n/g, '\n> ')}`;
  });

  // --- mock hovercard ---------------------------------------------------
  // Stands in for GitHub's profile popup so the injected row and the editor
  // panel can be checked without installing the extension. Two shapes, matching
  // the two implementations GitHub currently runs: the classic
  // `.js-hovercard-content` container, and the React overlay in the Primer
  // portal, opened from a plain profile link with no data-hovercard-url.

  const { usernameFromHovercardUrl, usernameFromUrl } = globalThis.GHUN;
  const cardsButton = document.getElementById('toggle-cards');
  let cardStyle = 'classic';
  let card = null;
  let cardTimer = null;

  cardsButton.addEventListener('click', () => {
    cardStyle = cardStyle === 'classic' ? 'react' : 'classic';
    cardsButton.textContent = cardStyle === 'classic' ? 'React hovercards' : 'Classic hovercards';
    hideCard();
  });

  function hideCard() {
    if (card) card.remove();
    card = null;
  }

  function usernameFor(trigger) {
    const annotated = trigger.getAttribute('data-hovercard-url');
    if (annotated) return usernameFromHovercardUrl(annotated);
    return usernameFromUrl(trigger.getAttribute('href') || '');
  }

  function cardBody(username, loginMarkup) {
    return (
      `<div class="mock-head"><span class="mock-avatar"></span>${loginMarkup}</div>` +
      '<p class="mock-bio">Engineering Manager · Tampa, Florida</p>' +
      '<p class="mock-bio">Opened this pull request</p>'
    );
  }

  function showCard(trigger) {
    hideCard();
    const username = usernameFor(trigger);
    if (!username) return;

    const rect = trigger.getBoundingClientRect();
    card = document.createElement('div');
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.bottom + 8}px`;
    card.addEventListener('mouseleave', hideCard);

    if (cardStyle === 'react') {
      // The React card links to the profile; that link is how the extension
      // identifies an unlabelled overlay as this user's hovercard.
      card.className = 'mock-react-overlay';
      card.innerHTML = cardBody(
        username,
        `<a class="mock-login" href="/${username}">${username}</a>`
      );
      document.getElementById('__primerPortalRoot__').appendChild(card);
      return;
    }

    card.className = 'js-hovercard-content';
    card.innerHTML =
      `<div class="Popover-message">${cardBody(
        username,
        `<span class="mock-login">${username}</span>`
      )}</div>`;
    document.body.appendChild(card);
  }

  document.addEventListener('mouseover', (event) => {
    if (!event.target.closest) return;
    // Links inside the open card must not re-trigger it.
    if (card && card.contains(event.target)) return;

    let trigger = event.target.closest('[data-hovercard-url]');
    if (!trigger && cardStyle === 'react') {
      // The rewritten surfaces trigger from plain profile links.
      const link = event.target.closest('a[href]');
      if (link && usernameFromUrl(link.getAttribute('href'))) trigger = link;
    }
    if (!trigger) return;

    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => showCard(trigger), 200);
  });

  document.addEventListener('mouseout', (event) => {
    const trigger = event.target.closest && event.target.closest('[data-hovercard-url], a[href]');
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
