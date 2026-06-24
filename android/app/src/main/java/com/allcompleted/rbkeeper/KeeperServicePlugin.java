package com.allcompleted.rbkeeper;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Bridges {@link KeeperService} to JS. {@code start()} ensures the POST_NOTIFICATIONS
 * permission (Android 13+) then launches the foreground service; {@code stop()} tears
 * it down. Calling start() when already running is a harmless no-op (onStartCommand
 * just refreshes the notification).
 */
@CapacitorPlugin(
        name = "KeeperService",
        permissions = {
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class KeeperServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+ needs runtime consent to post the ongoing notification.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotifPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterNotifPermission(PluginCall call) {
        // Start regardless of the verdict: on older devices or if the user declines,
        // the service still runs (the system shows a minimal foreground notice).
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent intent = new Intent(getContext(), KeeperService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeeperService.class));
        call.resolve();
    }

    // -- Incoming-request alert (heads-up notification with sound + vibration) --
    static final String ALERT_CHANNEL_ID = "keeper_alerts";
    static final int ALERT_NOTIFICATION_ID = 4712;

    @PluginMethod
    public void notifyRequest(PluginCall call) {
        String title = call.getString("title", "A session needs a value");
        String body = call.getString("body", "Tap to respond in the Keeper");
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) { call.resolve(); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // IMPORTANCE_HIGH = heads-up banner + default sound + vibration.
            NotificationChannel ch = new NotificationChannel(
                    ALERT_CHANNEL_ID, "Keeper requests", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Alerts (sound + vibration) when a remote session needs a value.");
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(ctx, 1, launch, piFlags);
        Notification n = new NotificationCompat.Builder(ctx, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_keeper)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setDefaults(NotificationCompat.DEFAULT_ALL) // sound + vibration on pre-O
                .build();
        nm.notify(ALERT_NOTIFICATION_ID, n);
        call.resolve();
    }

    @PluginMethod
    public void setStatus(PluginCall call) {
        // Reflect the live connection state in the ongoing foreground notification.
        KeeperService.updateStatus(getContext(), call.getString("text", ""));
        call.resolve();
    }

    @PluginMethod
    public void clearAlert(PluginCall call) {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(ALERT_NOTIFICATION_ID);
        call.resolve();
    }
}
