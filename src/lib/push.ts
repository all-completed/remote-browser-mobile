// FCM registration for the wake-push "doorbell".
//
// The token enables the service to send a CONTENT-FREE wake when a request arrives
// while the app is deep-backgrounded/killed; the actual fill_request (fields, proof,
// value) still flows only over the authenticated keeper WebSocket. We never put
// anything sensitive in the push.
//
// - onToken: the FCM device token → send it over the WS (keeper.setFcmToken).
// - onWake:  app should make sure its socket is up so replay delivers the pending
//            request — fires both when a wake arrives in foreground and when the user
//            taps the heads-up notification from the background/killed state.
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

// High-importance channel the server's wake-push targets (channel_id="keeper_alerts").
// Created up front so a heads-up with sound shows even on the very first wake, before
// any in-app alert has ever run. On Android O+ the channel's settings win, so the
// sound/importance live here. (Re-creating an existing channel is a no-op.)
async function ensureAlertChannel(): Promise<void> {
  try {
    await PushNotifications.createChannel({
      id: 'keeper_alerts',
      name: 'Keeper requests',
      description: 'A browser session needs a value',
      importance: 5, // HIGH → heads-up
      visibility: 1, // public
      vibration: true,
      lights: true,
      // sound omitted → default notification sound
    });
  } catch {
    /* channel API unavailable — fall back to whatever the in-app alert created */
  }
}

// onWake(force): force=true means we were in the background/killed (the socket is
// likely a zombie → caller should force a fresh reconnect); force=false means the app
// was alive when the wake arrived (a gentle connect() is enough).
export async function initPush(onToken: (token: string) => void, onWake: (force: boolean) => void): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await ensureAlertChannel();
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', (t) => onToken(t.value));
    await PushNotifications.addListener('registrationError', () => {
      /* no token this run; WS still works, just no background wake */
    });
    // App alive when the wake arrives — a gentle re-assert is enough.
    await PushNotifications.addListener('pushNotificationReceived', () => onWake(false));
    // User tapped the heads-up from background/killed — the socket is likely a zombie,
    // so force a fresh reconnect to trigger the server's pending-request replay.
    await PushNotifications.addListener('pushNotificationActionPerformed', () => onWake(true));

    let receive = (await PushNotifications.checkPermissions()).receive;
    if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      receive = (await PushNotifications.requestPermissions()).receive;
    }
    if (receive === 'granted') await PushNotifications.register();
  } catch {
    /* push not available on this device — the WS path is unaffected */
  }
}
