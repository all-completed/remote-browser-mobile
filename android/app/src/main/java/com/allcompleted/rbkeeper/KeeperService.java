package com.allcompleted.rbkeeper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the Keeper process alive in the background and
 * shows a persistent, ongoing notification — the "icon in the tray" that tells the
 * user the Keeper is watching for fill/secret requests. Tapping it reopens the app.
 *
 * Started/stopped from JS via {@link KeeperServicePlugin}. The notification is
 * low-importance (no sound/vibration) and ongoing (the user can't swipe it away
 * while the service runs), which is exactly what a background watcher wants.
 */
public class KeeperService extends Service {
    static final String CHANNEL_ID = "keeper_status";
    static final int NOTIFICATION_ID = 4711;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires the type to be declared at startForeground time.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // START_STICKY: if Android kills us under memory pressure, recreate the
        // service (and notification) when resources free up.
        return START_STICKY;
    }

    private Notification buildNotification() {
        createChannel();

        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launch, piFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_keeper)
                .setContentTitle("Keeper is running")
                .setContentText("Watching for fill & secret requests")
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Keeper status",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows that the Keeper is running and watching for requests.");
            channel.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // not a bound service
    }
}
