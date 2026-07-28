import { Preferences } from '@capacitor/preferences';

// Per-device Keeper preferences (non-secret). Stored in Preferences; never synced.
//
//   generateShowWindow: when true, a password-generation request opens the prompt (so the
//     user reviews/edits/regenerates the value before it fills) instead of the default
//     fully-unattended path (generate + fill + save, no prompt). Default false.
const GEN_SHOW_WINDOW_KEY = 'rbkeeper.generateShowWindow';

export async function loadGenerateShowWindow(): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: GEN_SHOW_WINDOW_KEY });
    return value === 'true';
  } catch {
    return false;
  }
}

export async function setGenerateShowWindow(on: boolean): Promise<void> {
  try {
    await Preferences.set({ key: GEN_SHOW_WINDOW_KEY, value: on ? 'true' : 'false' });
  } catch {
    /* preferences unavailable (e.g. web preview) — not persisted */
  }
}
