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

// Adding an empty export statement ensures TypeScript treats this file as an ES Module instead of a global script.
export {};
