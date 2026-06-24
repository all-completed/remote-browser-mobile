package com.allcompleted.rbkeeper;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

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
}
