import { DND5eConfig } from './shared/models/dnd5e';

declare global {
  interface SettingConfig {
    'luck-ability.enableLuckSaves': boolean;
  }
}

const MODULE_ID = 'luck-ability';
const LUCK_ID = 'lck';
const DEFAULT_LUCK_VALUE = 10;
const DEFAULT_LUCK_MAX = 20;

/**
 * Initialization: Register the Luck attribute
 */
Hooks.once('init', function () {
  if ((game as Game).system.id !== 'dnd5e') return;

  registerLuckSettings();
  registerLuckAbility();
});

Hooks.once('ready', () => {
  if ((game as Game).system.id !== 'dnd5e') return;

  syncLuckSavesVisibility();

  const modules = (game as Game).modules as unknown as { get(id: string): { api?: Record<string, unknown> } | undefined };
  const mod = modules.get(MODULE_ID);
  if (mod) mod.api = { spendLuck: commitSpend };
});

// dnd5e v5 character sheet is ApplicationV2 (class `CharacterActorSheet`).
Hooks.on('renderCharacterActorSheet', (app: unknown, element: unknown) => {
  const sheet = app as { document?: Actor };
  if (sheet.document?.type !== 'character') return;
  const root =
    element instanceof HTMLElement
      ? element
      : (element as { 0?: HTMLElement } | null)?.[0];
  if (!root) return;
  if (!root.classList.contains('dnd5e2') && !root.closest('.dnd5e2')) return;
  if (activePopover) closeLuckPopover();
  attachLuckSpend(sheet.document, root);
});

/**
 * Intercept clicks on the Heroic Inspiration tracker to prompt the choice dialog.
 * We use a global capture-phase listener on the document. This catches the click
 * before the core Application event listeners can handle it, allowing us to stop it.
 */
document.addEventListener(
  'click',
  (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    // Find if the target or its ancestors is the inspiration toggle button
    const btn = target.closest(
      '[data-action="toggleInspiration"], .inspiration-toggle, .inspiration',
    ) as HTMLElement | null;
    if (!btn) return;

    // Ensure this is an inspiration button and the actor HAS inspiration ("aria-pressed" = true)
    // D&D 5e sets aria-pressed="true" when inspiration is active.
    if (btn.getAttribute('aria-pressed') === 'true') {
      // Locate the Actor securely before stopping propagation
      let actor: Actor | null = null;
      const appElement = btn.closest('.application, .window-app') as HTMLElement | null;

      if (appElement) {
        // 1. Attempt Application V2 Resolution
        if (typeof foundry !== 'undefined' && foundry.applications && foundry.applications.instances) {
          const app = foundry.applications.instances.get(appElement.id) as any;
          if (app?.document) actor = app.document;
        }

        // 2. Attempt Application V1 Resolution (Fallback)
        if (!actor && appElement.dataset.appid && typeof ui !== 'undefined' && ui.windows) {
          const appId = Number(appElement.dataset.appid);
          const app = ui.windows[appId];
          if (app) {
            actor = (app as any).document || (app as any).object || null;
          }
        }
      }

      if (actor) {
        if (!actor.isOwner) return;
        if (actor.type !== 'character') return;

        const sys = actor.system as Dnd5eActorSystem;
        const hasInspiration = sys.attributes.inspiration;
        if (!hasInspiration) return;

        const { currentLuck, maxLuck } = getLuckValues(actor);

        if (currentLuck >= maxLuck) {
          // Luck is maxed out. Do not intercept. Permit default 5e inspiration consumption.
          return;
        }

        // We found an active inspiration button, and luck is less than max.
        // Stop the default consumption handler of the sheet.
        ev.stopPropagation();
        ev.preventDefault();

        promptInspirationChoice(actor);
      } else {
        console.warn('Luck Ability Module | Could not find actor for inspiration click.');
      }
    }
  },
  true,
); // Use capture phase

/**
 * Add 'lck' to Dnd5e's ability list. This integrates it automatically into the schema and sheets
 */
function registerLuckAbility(): void {
  const config = CONFIG as unknown as DND5eConfig;
  if (config.DND5E?.abilities) {
    config.DND5E.abilities = {
      ...config.DND5E.abilities,
      [LUCK_ID]: {
        label: 'Luck',
        abbreviation: 'lck',
        fullKey: 'luck',
        type: 'mental',
        defaults: { value: DEFAULT_LUCK_VALUE, max: DEFAULT_LUCK_MAX },
        improvement: true,
      },
    };
  }
}

function registerLuckSettings(): void {
  (game as Game).settings.register(MODULE_ID, 'enableLuckSaves', {
    name: 'Allow Luck Saving Throws',
    hint: 'Show the Luck Saving Throw option in character sheets',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange: syncLuckSavesVisibility,
  });
}

function syncLuckSavesVisibility() {
  const enabled = (game as Game).settings.get(MODULE_ID, 'enableLuckSaves');
  document.documentElement.style.setProperty('--luck-saves-visible', enabled ? 'block' : 'none');
}

interface Dnd5eActorSystem {
  attributes: { inspiration?: boolean };
  abilities: { [key: string]: { value: number; max: number } | undefined };
}

interface LuckValues {
  currentLuck: number;
  maxLuck: number;
}

function getLuckValues(actor: Actor): LuckValues {
  const sys = actor.system as Dnd5eActorSystem;
  return {
    currentLuck: sys.abilities[LUCK_ID]?.value ?? DEFAULT_LUCK_VALUE,
    maxLuck: sys.abilities[LUCK_ID]?.max ?? DEFAULT_LUCK_MAX,
  };
}

function onInspirationError(err: unknown): void {
  console.error('Luck Module | Error consuming inspiration:', err);
  ui.notifications?.error('Failed to consume inspiration.');
}

/**
 * Dialog to provide options for Heroic Inspiration
 */
async function promptInspirationChoice(actor: Actor): Promise<void> {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Heroic Inspiration' },
    content: `
            <div style="margin-bottom: 10px;">
                <p>You have <strong>Heroic Inspiration</strong>.</p>
                <p>How would you like to use it?</p>
            </div>
        `,
    buttons: [
      { action: 'advantage', icon: 'fas fa-dice-d20', label: 'Advantage', default: true },
      { action: 'luck', icon: 'fas fa-clover', label: 'Recover Luck' },
    ],
    rejectClose: false,
  });
  if (!result) return;
  consumeInspiration(actor, result as 'luck' | 'advantage').catch(onInspirationError);
}

/**
 * Execute the chosen Inspiration action
 */
async function consumeInspiration(actor: Actor, choice: 'luck' | 'advantage'): Promise<void> {
  try {
    if (choice === 'luck') {
      // Recover 1d4 Luck
      const roll = new Roll('1d4');
      await roll.evaluate(); // .evaluate() is async in Foundry v12+

      const { currentLuck, maxLuck } = getLuckValues(actor);

      let recoveredRaw = roll.total ?? 0;
      let recovered = recoveredRaw;
      let newLuck = currentLuck + recoveredRaw;

      // Enforce max cap
      if (newLuck > maxLuck) {
        recovered = Math.max(0, maxLuck - currentLuck);
        newLuck = maxLuck;
      }

      // Atomic update: consume inspiration and update luck limit simultaneously
      const updateData: Record<string, boolean | number> = { 'system.attributes.inspiration': false };
      if (recovered > 0) {
        updateData['system.abilities.lck.value'] = newLuck;
      }
      await actor.update(updateData);

      // Create beautiful chat message
      const speaker = ChatMessage.getSpeaker({ actor });

      const flavorText = `<div class="dnd5e chat-card">
                <header class="card-header flexrow">
                    <img src="icons/magic/light/explosion-star-glow-yellow.webp" title="Heroic Inspiration" width="36" height="36"/>
                    <h3 class="luck-heading">Recover Luck</h3>
                </header>
                <div class="card-content">
                    <p>Uses Heroic Inspiration to recover Luck!</p>
                </div>
                <footer class="card-footer" style="padding-top: 5px; font-weight: bold;">
                    ${recovered > 0 ? `Recovered ${recovered} Luck! (New Total: ${newLuck})` : `Luck is already at maximum (${maxLuck})!`}
                </footer>
            </div>`;

      roll.toMessage({
        speaker: speaker,
        flavor: flavorText,
      } as Parameters<typeof roll.toMessage>[0]);
    } else if (choice === 'advantage') {
      // Standard Advantage -> just consume inspiration
      await actor.update({ 'system.attributes.inspiration': false });

      // If they chose standard Advantage, print a small chat message noting inspiration usage
      const safeName = Handlebars.Utils.escapeExpression(actor.name || 'Unknown');
      const speaker = ChatMessage.getSpeaker({ actor });
      ChatMessage.create({
        speaker: speaker,
        content: `<div class="dnd5e chat-card">
                    <header class="card-header flexrow">
                        <img src="icons/magic/light/explosion-star-glow-yellow.webp" title="Heroic Inspiration" width="36" height="36"/>
                        <h3 class="luck-heading">Heroic Inspiration</h3>
                    </header>
                    <div class="card-content">
                        <p><strong>${safeName}</strong> uses their Heroic Inspiration to gain Advantage!</p>
                    </div>
                </div>`,
      });
    }
  } catch (e) {
    console.error('Luck Module | Error during inspiration consumption', e);
    ui.notifications?.error('Failed to update actor or roll dice.');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Quick-spend Luck (Clover): hover → "Spend", click → popover with slider.
// ────────────────────────────────────────────────────────────────────────────

const CLOVER_SVG = `
<svg viewBox="0 0 64 64" width="68" height="68" aria-hidden="true">
  <defs>
    <radialGradient id="luckLeafGrad" cx="0.5" cy="0.35" r="0.85">
      <stop offset="0" stop-color="#fce8b8" />
      <stop offset="0.5" stop-color="#e6c46c" />
      <stop offset="0.85" stop-color="#b88a40" />
      <stop offset="1" stop-color="#8b6a30" />
    </radialGradient>
    <path id="luckCloverLeaf"
      d="M 0 0 C -3 -4, -12 -8, -12 -16 C -12 -23, -5 -25, -2 -22 C -1 -21, -0.5 -20, 0 -19 C 0.5 -20, 1 -21, 2 -22 C 5 -25, 12 -23, 12 -16 C 12 -8, 3 -4, 0 0 Z" />
  </defs>
  <g transform="translate(32 30)">
    <path d="M 0 6 Q 5 18 -3 28" stroke="#7a5828" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.9" />
    <use href="#luckCloverLeaf" fill="url(#luckLeafGrad)" stroke="rgba(255,240,200,0.45)" stroke-width="0.6" />
    <use href="#luckCloverLeaf" fill="url(#luckLeafGrad)" stroke="rgba(255,240,200,0.45)" stroke-width="0.6" transform="rotate(90)" />
    <use href="#luckCloverLeaf" fill="url(#luckLeafGrad)" stroke="rgba(255,240,200,0.45)" stroke-width="0.6" transform="rotate(180)" />
    <use href="#luckCloverLeaf" fill="url(#luckLeafGrad)" stroke="rgba(255,240,200,0.45)" stroke-width="0.6" transform="rotate(270)" />
  </g>
</svg>`;

const POPOVER_HTML = `
<div class="luck-spend-title">Spend Luck · drag to set</div>
<div class="luck-spend-stage">
  <div class="luck-clover" data-armed="0">
    ${CLOVER_SVG}
    <span class="luck-clover-num">0</span>
  </div>
  <div class="luck-spend-track">
    <div class="luck-spend-fill"></div>
    <div class="luck-spend-thumb"></div>
  </div>
</div>
<div class="luck-spend-foot">
  <span class="luck-spend-hint">release at 0 cancels</span>
  <span class="luck-spend-preview"></span>
</div>`;

let activePopover: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

function attachLuckSpend(actor: Actor, root: HTMLElement): void {
  // Edit mode detection: dnd5e2 uses a <slide-toggle>; `checked` ⇒ edit mode.
  const toggle = root.querySelector('slide-toggle') as HTMLElement & { checked?: boolean } | null;
  if (toggle?.checked) return;

  // There can be multiple [data-ability="lck"] elements (saves list `<li>` AND
  // the ability-scores strip). We want the one with the numeric `.score` child.
  const candidates = Array.from(root.querySelectorAll('[data-ability="lck"]')) as HTMLElement[];
  const abilityEl = candidates.find((el) => el.querySelector('.score')) ?? null;
  if (!abilityEl) return;
  const scoreEl = abilityEl.querySelector('.score') as HTMLElement | null;
  if (!scoreEl) return;
  if (scoreEl.dataset.luckSpendBound === '1') return;
  scoreEl.dataset.luckSpendBound = '1';

  const valueText = (scoreEl.textContent ?? '').trim();
  scoreEl.classList.add('luck-spend-trigger');
  scoreEl.innerHTML = `<span class="luck-spend-value">${Handlebars.Utils.escapeExpression(valueText)}</span><span class="luck-spend-hover" aria-hidden="true">Spend</span>`;
  scoreEl.setAttribute('role', 'button');
  scoreEl.setAttribute('aria-label', `Spend Luck (current ${valueText})`);

  scoreEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (activePopover) {
      closeLuckPopover();
      return;
    }
    openLuckPopover(actor, scoreEl);
  });
}

function openLuckPopover(actor: Actor, trigger: HTMLElement): void {
  const { currentLuck } = getLuckValues(actor);
  if (currentLuck <= 0) return;

  const pop = document.createElement('div');
  pop.className = 'luck-spend-popover';
  pop.innerHTML = POPOVER_HTML;
  document.body.appendChild(pop);

  // Initial preview
  const previewEl = pop.querySelector('.luck-spend-preview') as HTMLElement;
  previewEl.textContent = `${currentLuck} → ${currentLuck}`;

  // Position centered below trigger
  const r = trigger.getBoundingClientRect();
  // We position the popover so its top sits 10px below the trigger; the CSS arrow is centered horizontally.
  pop.style.left = `${Math.round(r.left + r.width / 2)}px`;
  pop.style.top = `${Math.round(r.bottom + 10)}px`;

  trigger.dataset.open = '1';
  activePopover = pop;

  const cleanupFns: Array<() => void> = [];

  // ── Slider drag ────────────────────────────────────────────────────────
  const track = pop.querySelector('.luck-spend-track') as HTMLElement;
  const fill = pop.querySelector('.luck-spend-fill') as HTMLElement;
  const thumb = pop.querySelector('.luck-spend-thumb') as HTMLElement;
  const cloverWrap = pop.querySelector('.luck-clover') as HTMLElement;
  const cloverNum = pop.querySelector('.luck-clover-num') as HTMLElement;
  const hintEl = pop.querySelector('.luck-spend-hint') as HTMLElement;

  let amount = 0;
  let dragging = false;

  const setAmountFromX = (clientX: number): void => {
    const rect = track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const next = Math.max(0, Math.min(currentLuck, Math.round(t * currentLuck)));
    if (next === amount) return;
    amount = next;
    const pct = currentLuck > 0 ? (amount / currentLuck) * 100 : 0;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    cloverNum.textContent = String(amount);
    cloverWrap.dataset.armed = amount > 0 ? '1' : '0';
    previewEl.textContent = `${currentLuck} → ${currentLuck - amount}`;
    hintEl.textContent = amount > 0 ? 'release to commit' : 'release at 0 cancels';
  };

  const onPointerDown = (ev: PointerEvent): void => {
    dragging = true;
    track.setPointerCapture?.(ev.pointerId);
    setAmountFromX(ev.clientX);
  };
  const onPointerMove = (ev: PointerEvent): void => {
    if (!dragging) return;
    setAmountFromX(ev.clientX);
  };
  const onPointerUp = (): void => {
    if (!dragging) return;
    dragging = false;
    const finalAmount = amount;
    closeLuckPopover();
    if (finalAmount > 0) {
      commitSpend(actor, currentLuck, finalAmount).catch((e) => {
        console.error('Luck Module | Spend commit failed', e);
        ui.notifications?.error('Failed to spend Luck.');
      });
    }
  };

  track.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  cleanupFns.push(() => {
    track.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  });

  // ── Outside click + Escape ─────────────────────────────────────────────
  const onDocPointer = (ev: PointerEvent): void => {
    const t = ev.target as Node | null;
    if (!t) return;
    if (pop.contains(t) || trigger.contains(t)) return;
    closeLuckPopover();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') closeLuckPopover();
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey, true);
  cleanupFns.push(() => {
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onKey, true);
  });

  activeCleanup = () => {
    for (const fn of cleanupFns) fn();
  };
}

function closeLuckPopover(): void {
  if (!activePopover) return;
  activeCleanup?.();
  activeCleanup = null;
  const trigger = document.querySelector('.luck-spend-trigger[data-open="1"]') as HTMLElement | null;
  if (trigger) delete trigger.dataset.open;
  activePopover.remove();
  activePopover = null;
}

async function commitSpend(actor: Actor, currentLuck: number, amount: number): Promise<void> {
  if (amount <= 0) return;
  const newLuck = Math.max(0, currentLuck - amount);
  await actor.update({ 'system.abilities.lck.value': newLuck });

  const safeName = Handlebars.Utils.escapeExpression(actor.name ?? 'Unknown');
  const speaker = ChatMessage.getSpeaker({ actor });
  await ChatMessage.create({
    speaker,
    content: `<div class="dnd5e chat-card">
      <header class="card-header flexrow" style="align-items:center;">
        <i class="fa-solid fa-clover" style="font-size:28px;color:#3a7d3a;margin-right:8px;"></i>
        <h3 class="luck-heading">Spend Luck</h3>
      </header>
      <div class="card-content">
        <p><strong>${safeName}</strong> spends <strong>${amount}</strong> Luck. (${currentLuck} → ${newLuck})</p>
      </div>
    </div>`,
  });
}

// Adding an empty export statement ensures TypeScript treats this file as an ES Module instead of a global script.
export {};
