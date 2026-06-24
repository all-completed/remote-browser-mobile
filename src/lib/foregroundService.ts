// Bridge to the native Android foreground service (KeeperServicePlugin). The service
// shows a persistent tray notification and keeps the Keeper process alive in the
// background so it can keep answering fill/secret requests. No-op on web/iOS.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface KeeperServicePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
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
};
