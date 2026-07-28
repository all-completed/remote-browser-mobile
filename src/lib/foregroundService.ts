// Bridge to the native Android foreground service (KeeperServicePlugin). The service
// shows a persistent tray notification and keeps the Keeper process alive in the
// background so it can keep answering fill/secret requests. No-op on web/iOS.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface KeeperServicePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  notifyRequest(opts: { title: string; body: string }): Promise<void>;
  clearAlert(): Promise<void>;
  setStatus(opts: { text: string }): Promise<void>;
  isBatteryOptimizationIgnored(): Promise<{ ignored: boolean }>;
  requestIgnoreBatteryOptimization(): Promise<{ ignored: boolean; prompted: boolean }>;
}

const Native = registerPlugin<KeeperServicePlugin>('KeeperService');

const isAndroid = () => Capacitor.getPlatform() === 'android';

export const foregroundService = {
  async start(): Promise<void> {
    if (!isAndroid()) return;
    try {
      await Native.start();
    } catch (e) {
      // Service is best-effort; the app still works in the foreground without it.
      console.warn('[keeper] foreground service start failed', e);
    }
  },
  async stop(): Promise<void> {
    if (!isAndroid()) return;
    try {
      await Native.stop();
    } catch (e) {
      console.warn('[keeper] foreground service stop failed', e);
    }
  },
  // Heads-up notification (sound + vibration) when a request arrives in the background.
  async notifyRequest(title: string, body: string): Promise<void> {
    if (!isAndroid()) return;
    try {
      await Native.notifyRequest({ title, body });
    } catch (e) {
      console.warn('[keeper] notifyRequest failed', e);
    }
  },
  async clearAlert(): Promise<void> {
    if (!isAndroid()) return;
    try {
      await Native.clearAlert();
    } catch {
      /* ignore */
    }
  },
  // Reflect the live keeper connection state in the ongoing notification.
  async setStatus(text: string): Promise<void> {
    if (!isAndroid()) return;
    try {
      await Native.setStatus({ text });
    } catch {
      /* ignore */
    }
  },

  // ---- Doze exemption ------------------------------------------------------
  // Wake-pushes are already sent at FCM priority "high", but Android still DEFERS
  // them for battery-optimized apps that are idle — which is why a request can go
  // unnoticed until the screen is next turned on. Exempting the app is what makes
  // "wake every time" actually hold.
  async isBatteryOptimizationIgnored(): Promise<boolean> {
    if (!isAndroid()) return true;
    try {
      return !!(await Native.isBatteryOptimizationIgnored()).ignored;
    } catch {
      return true; // unknown → don't nag
    }
  },
  // Opens the system consent dialog. The user must approve; an app cannot grant
  // this to itself. No-op when already exempt, so calling on launch is safe.
  async requestIgnoreBatteryOptimization(): Promise<boolean> {
    if (!isAndroid()) return true;
    try {
      return !!(await Native.requestIgnoreBatteryOptimization()).ignored;
    } catch (e) {
      console.warn('[keeper] battery-optimization request failed', e);
      return false;
    }
  },
};
