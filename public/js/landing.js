const hasIntersectionObserver = typeof IntersectionObserver !== 'undefined';

const revealObserver = hasIntersectionObserver
  ? new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target: revealTarget }) => {
        if (!isIntersecting) return;

        revealTarget.classList.add('in');
        revealObserver.unobserve(revealTarget);
      });
    }, { threshold: 0.12 })
  : null;

document.querySelectorAll('.reveal').forEach((revealTarget, position) => {
  revealTarget.style.transitionDelay = `${Math.min(position % 4, 3) * 70}ms`;

  if (revealObserver) revealObserver.observe(revealTarget);
  else revealTarget.classList.add('in');
});

const menuButton = document.querySelector('.menu-button');
const headerNavigation = document.querySelector('.site-header nav');

const closeMobileNavigation = () => {
  menuButton?.setAttribute('aria-expanded', 'false');
  headerNavigation?.classList.remove('open');
};

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  headerNavigation?.classList.toggle('open', !isOpen);
});

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (event) => {
    closeMobileNavigation();
    if (anchor.dataset.pageTarget) return;

    const href = anchor.getAttribute('href');
    if (!href || href === '#') return;

    const destination = document.getElementById(href.slice(1));
    if (!destination) return;

    event.preventDefault();
    destination.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (anchor.classList.contains('skip-link')) {
      window.setTimeout(() => destination.focus({ preventScroll: true }), 0);
    }
  });
});

const siteLayer = document.querySelector('.site-layer');
const siteLayerBody = siteLayer?.querySelector('.site-layer-body');
const siteLayerPanel = siteLayer?.querySelector('.site-layer-panel');
const siteLayerTitle = siteLayer?.querySelector('#site-layer-title');
const siteLayerClose = siteLayer?.querySelector('.site-layer-close');
const baseDocumentTitle = document.title;

const pageTitles = {
  start: 'Get Started for Free',
  how: 'How we actually carry out our promise to you',
  problems: 'Problems We Solve For You',
};

const pageDefinitions = {
  start: [
    { source: 'start-page-source' },
    { source: 'roles' },
    { source: 'faq' },
  ],
  how: [
    { source: 'workflow' },
    {
      source: 'offer',
      selectors: ['.offer-urgency', '.offer-risk'],
      className: 'internal-action-section',
      combine: true,
    },
    { source: 'getting-started' },
    { source: 'benefits' },
  ],
  problems: [
    { source: 'problems', removeSelectors: ['.problem-deliverables-area'] },
  ],
};

let lastFocusedElement = null;
let layerCloseTimer;

const copySourceSection = (sourceSection, selectorsToRemove = []) => {
  const clonedSource = sourceSection.cloneNode(true);
  const sourceId = sourceSection.getAttribute('id');

  clonedSource.removeAttribute('id');
  if (sourceId) clonedSource.dataset.pageSourceId = sourceId;

  selectorsToRemove.forEach((selector) => {
    clonedSource.querySelectorAll(selector).forEach((node) => node.remove());
  });

  clonedSource.classList.remove('is-deliverables-aligned', 'is-decision-aligned');
  clonedSource.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  clonedSource.querySelectorAll('.reveal, .motion-item').forEach((node) => {
    node.classList.add('in', 'motion-in');
    node.style.transitionDelay = '0ms';
  });

  const layoutProperties = [
    '--deliverables-offset',
    '--deliverables-height',
    '--decision-row-height',
    '--urgency-offset',
  ];

  clonedSource.querySelectorAll('[style]').forEach((node) => {
    layoutProperties.forEach((propertyName) => node.style.removeProperty(propertyName));
  });

  return clonedSource;
};

const buildInternalPage = (pageKey) => {
  const pageContent = document.createElement('div');
  pageContent.className = `internal-page-content internal-page-${pageKey}`;

  pageDefinitions[pageKey].forEach((pagePart) => {
    const sourceSection = document.getElementById(pagePart.source);
    if (!sourceSection) return;

    if (!pagePart.selectors) {
      pageContent.append(copySourceSection(sourceSection, pagePart.removeSelectors));
      return;
    }

    const sectionShell = document.createElement('section');
    sectionShell.className = 'internal-page-section internal-offer-section';
    if (pagePart.className) sectionShell.classList.add(pagePart.className);

    if (pagePart.heading) {
      const sectionHeading = document.createElement('h3');
      sectionHeading.className = 'internal-page-section-heading';
      sectionHeading.textContent = pagePart.heading;
      sectionShell.append(sectionHeading);
    }

    const cardGroup = document.createElement('div');
    cardGroup.className = pagePart.combine ? 'internal-combined-action' : 'internal-offer-cards';

    pagePart.selectors.forEach((selector) => {
      const matchingCard = sourceSection.querySelector(selector);
      if (matchingCard) cardGroup.append(copySourceSection(matchingCard));
    });

    sectionShell.append(cardGroup);
    pageContent.append(sectionShell);
  });

  return pageContent;
};

const setActivePage = (pageKey) => {
  document.querySelectorAll('[data-page-target]').forEach((trigger) => {
    const isCurrent = trigger.dataset.pageTarget === pageKey;
    trigger.classList.toggle('is-current', isCurrent);

    if (isCurrent) trigger.setAttribute('aria-current', 'page');
    else trigger.removeAttribute('aria-current');
  });
};

const landingViewRoot = document.getElementById('landing-view');

// Deliberately not document.querySelector('main')/('footer') - the
// standalone project's own <main id="main"> was renamed to <div
// id="landing-main"> when it was merged into the app (to avoid an invalid
// nested <main> inside the app's real main#app - see CLAUDE.md), so a
// global 'main' query now matches main#app itself. #site-layer lives
// inside that same main#app, so marking it inert along with the true
// background regions would make the overlay this function just opened
// completely unresponsive to clicks/scroll (it still renders - inert
// only blocks interaction). Scope explicitly to landing-view's own
// background regions instead.
const setBackgroundInert = (shouldDisable) => {
  const backgroundRegions = [
    landingViewRoot?.querySelector('.site-header'),
    document.getElementById('landing-main'),
    landingViewRoot?.querySelector('footer'),
  ];

  backgroundRegions.forEach((region) => {
    if (!region) return;

    region.inert = shouldDisable;
    if (shouldDisable) region.setAttribute('aria-hidden', 'true');
    else region.removeAttribute('aria-hidden');
  });
};

const focusableSelector = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

const setWorkflowState = (container, activeStep) => {
  if (!container) return;

  container.querySelectorAll('.workflow-step').forEach((workflowStep, stepNumber) => {
    workflowStep.classList.toggle('is-active', stepNumber === activeStep);
  });

  container.querySelectorAll('.workflow-nav button').forEach((stageButton, buttonNumber) => {
    const isActive = buttonNumber === activeStep;
    stageButton.classList.toggle('is-active', isActive);
    stageButton.setAttribute('aria-pressed', String(isActive));
  });
};

const setProblemState = (container, activeProblem) => {
  if (!container) return;

  container.querySelectorAll('.problem-card').forEach((problemCard, cardNumber) => {
    problemCard.classList.toggle('is-active', cardNumber === activeProblem);
  });
};

const syncLayerWorkflow = () => {
  if (!siteLayerBody) return;

  const workflowSteps = [...siteLayerBody.querySelectorAll('.workflow-step')];
  if (!workflowSteps.length) return;

  const scrollArea = siteLayerBody.getBoundingClientRect();
  const centerLine = scrollArea.top + scrollArea.height / 2;
  let activeStep = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  workflowSteps.forEach((workflowStep, stepNumber) => {
    const stepBounds = workflowStep.getBoundingClientRect();
    const stepCenter = stepBounds.top + stepBounds.height / 2;
    const distanceToCenter = Math.abs(stepCenter - centerLine);

    if (distanceToCenter < closestDistance) {
      closestDistance = distanceToCenter;
      activeStep = stepNumber;
    }
  });

  setWorkflowState(siteLayerBody, activeStep);
};

const syncLayerProblems = () => {
  if (!siteLayerBody) return;

  const problemCards = [...siteLayerBody.querySelectorAll('.problem-card')];
  if (!problemCards.length) return;

  const scrollArea = (siteLayerPanel || siteLayerBody).getBoundingClientRect();
  const centerLine = scrollArea.top + scrollArea.height / 2;
  let activeProblem = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  problemCards.forEach((problemCard, cardNumber) => {
    const cardBounds = problemCard.getBoundingClientRect();
    const cardCenter = cardBounds.top + cardBounds.height / 2;
    const distanceToCenter = Math.abs(cardCenter - centerLine);

    if (distanceToCenter < closestDistance) {
      closestDistance = distanceToCenter;
      activeProblem = cardNumber;
    }
  });

  setProblemState(siteLayerBody, activeProblem);
};

const syncLayerMotion = () => {
  syncLayerWorkflow();
  syncLayerProblems();
};

const openInternalPage = (pageKey, sourceTrigger) => {
  if (!siteLayer || !siteLayerBody || !pageDefinitions[pageKey]) return;

  window.clearTimeout(layerCloseTimer);
  closeMobileNavigation();

  const triggerIsInsideLayer = sourceTrigger && siteLayer.contains(sourceTrigger);
  if (!triggerIsInsideLayer) lastFocusedElement = sourceTrigger || document.activeElement;

  siteLayerBody.replaceChildren(buildInternalPage(pageKey));
  siteLayerBody.scrollTop = 0;

  if (siteLayerTitle) siteLayerTitle.textContent = pageTitles[pageKey];
  document.title = `SiteStock — ${pageTitles[pageKey]}`;
  setActivePage(pageKey);
  setBackgroundInert(true);

  siteLayer.hidden = false;
  siteLayer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('layer-open');

  requestAnimationFrame(() => {
    siteLayer.classList.add('is-open');
    if (pageKey === 'how') syncLayerWorkflow();
    if (pageKey === 'problems') syncLayerProblems();
  });

  siteLayerClose?.focus();
};

const closeInternalPage = () => {
  if (!siteLayer || siteLayer.hidden) return;

  window.clearTimeout(layerCloseTimer);
  siteLayer.classList.remove('is-open');
  setActivePage('home');

  layerCloseTimer = window.setTimeout(() => {
    siteLayer.hidden = true;
    siteLayer.setAttribute('aria-hidden', 'true');
    siteLayerBody?.replaceChildren();
    document.body.classList.remove('layer-open');
    setBackgroundInert(false);
    document.title = baseDocumentTitle;

    const focusReturn = lastFocusedElement;
    lastFocusedElement = null;
    focusReturn?.focus?.();
  }, 220);
};

document.querySelectorAll('[data-page-target]').forEach((pageTrigger) => {
  pageTrigger.addEventListener('click', (event) => {
    event.preventDefault();

    if (pageTrigger.dataset.pageTarget === 'home') closeInternalPage();
    else openInternalPage(pageTrigger.dataset.pageTarget, pageTrigger);
  });
});

siteLayer?.addEventListener('click', (event) => {
  const clickedElement = event.target instanceof Element ? event.target : null;
  const pageTrigger = clickedElement?.closest('[data-page-target]');

  if (pageTrigger && siteLayerBody?.contains(pageTrigger)) {
    event.preventDefault();

    if (pageTrigger.dataset.pageTarget === 'home') closeInternalPage();
    else openInternalPage(pageTrigger.dataset.pageTarget, pageTrigger);
    return;
  }

  if (clickedElement?.closest('[data-layer-close]')) closeInternalPage();
});

siteLayer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !siteLayer.classList.contains('is-open')) return;

  const focusableElements = [...siteLayer.querySelectorAll(focusableSelector)]
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
  if (!focusableElements.length) return;

  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  if (event.shiftKey && document.activeElement === firstFocusable) {
    event.preventDefault();
    lastFocusable.focus();
  } else if (!event.shiftKey && document.activeElement === lastFocusable) {
    event.preventDefault();
    firstFocusable.focus();
  }
});

siteLayerBody?.addEventListener('click', (event) => {
  const clickedElement = event.target instanceof Element ? event.target : null;
  const stageButton = clickedElement?.closest('.workflow-nav button');

  if (stageButton && siteLayerBody.contains(stageButton)) {
    const requestedStep = Number(stageButton.dataset.step);
    const workflowSteps = [...siteLayerBody.querySelectorAll('.workflow-step')];
    const requestedCard = workflowSteps[requestedStep];

    if (requestedCard) {
      setWorkflowState(siteLayerBody, requestedStep);
      requestedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const anchor = clickedElement?.closest('a[href^="#"]');
  if (!anchor) return;

  if (anchor.getAttribute('aria-disabled') === 'true' || anchor.classList.contains('button-disabled')) {
    event.preventDefault();
    return;
  }

  const href = anchor.getAttribute('href');
  if (!href || href === '#') return;

  const destinationKey = href.slice(1);
  const internalDestination = [...siteLayerBody.querySelectorAll('[data-page-source-id]')]
    .find((node) => node.dataset.pageSourceId === destinationKey);

  if (internalDestination) {
    event.preventDefault();
    internalDestination.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const pageDestination = document.getElementById(destinationKey);
  if (!pageDestination) return;

  event.preventDefault();
  closeInternalPage();
  window.setTimeout(() => pageDestination.scrollIntoView({ behavior: 'smooth', block: 'start' }), 240);
});

siteLayerBody?.addEventListener('scroll', syncLayerMotion, { passive: true });
siteLayerPanel?.addEventListener('scroll', syncLayerMotion, { passive: true });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && siteLayer?.classList.contains('is-open')) closeInternalPage();
});

// The split layout uses measured offsets so the deliverables card lines up with the action card.
const decisionRow = document.querySelector('.offer-problem-row');
const problemSection = document.querySelector('.problem-section');
const deliverablesArea = document.querySelector('.problem-deliverables-area');
const problemGrid = document.querySelector('.problem-grid');
const urgencyCard = document.querySelector('.offer-urgency');

const getLayoutTop = (node) => {
  const bounds = node.getBoundingClientRect();
  const transform = getComputedStyle(node).transform;
  const transformValues = transform.match(/matrix(?:3d)?\((.+)\)/)?.[1].split(',').map(Number) ?? [];
  const verticalShift = transformValues.length === 16
    ? transformValues[13]
    : transformValues.length === 6
      ? transformValues[5]
      : 0;

  return bounds.top - (Number.isFinite(verticalShift) ? verticalShift : 0);
};

const alignDecisionPanels = () => {
  if (!decisionRow || !problemSection || !deliverablesArea || !problemGrid || !urgencyCard) return;

  decisionRow.classList.remove('is-decision-aligned');
  problemSection.classList.remove('is-deliverables-aligned');
  decisionRow.style.removeProperty('--decision-row-height');
  decisionRow.style.removeProperty('--urgency-offset');
  problemSection.style.removeProperty('--deliverables-offset');
  problemSection.style.removeProperty('--deliverables-height');

  if (!window.matchMedia('(min-width: 681px)').matches) return;

  const rowBounds = decisionRow.getBoundingClientRect();
  const problemTop = problemSection.getBoundingClientRect().top;
  const gridBottom = problemGrid.getBoundingClientRect().bottom;
  const urgencyTop = getLayoutTop(urgencyCard);
  const deliverablesTop = Math.max(0, gridBottom + 10 - problemTop);
  const deliverablesBottom = Math.max(deliverablesTop, urgencyTop - problemTop);
  const deliverablesHeight = deliverablesBottom - deliverablesTop;

  decisionRow.style.setProperty('--decision-row-height', `${rowBounds.height}px`);
  decisionRow.style.setProperty('--urgency-offset', `${Math.max(0, urgencyTop - rowBounds.top)}px`);
  problemSection.style.setProperty('--deliverables-offset', `${deliverablesTop}px`);
  problemSection.style.setProperty('--deliverables-height', `${deliverablesHeight}px`);
  decisionRow.classList.add('is-decision-aligned');
  problemSection.classList.add('is-deliverables-aligned');
};

alignDecisionPanels();
window.addEventListener('resize', alignDecisionPanels);
window.addEventListener('load', alignDecisionPanels, { once: true });
if (document.fonts?.ready) document.fonts.ready.then(alignDecisionPanels);

document.addEventListener('toggle', (event) => {
  const openedDetails = event.target;
  if (!(openedDetails instanceof HTMLDetailsElement) || !openedDetails.open) return;

  document.querySelectorAll('details[open]').forEach((otherDetails) => {
    if (otherDetails !== openedDetails) otherDetails.open = false;
  });
}, true);

const motionObserver = hasIntersectionObserver
  ? new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target: motionTarget }) => {
        if (!isIntersecting) return;

        motionTarget.classList.add('motion-in');
        motionObserver.unobserve(motionTarget);
      });
    }, { threshold: 0.15 })
  : null;

document.querySelectorAll('.offer-card, .problem-card, .benefits-grid article, .role-row').forEach((motionTarget, position) => {
  motionTarget.classList.add('motion-item');
  motionTarget.style.setProperty('--motion-delay', `${Math.min(position % 4, 3) * 55}ms`);

  if (motionObserver) motionObserver.observe(motionTarget);
  else motionTarget.classList.add('motion-in');
});

setWorkflowState(document, 0);
