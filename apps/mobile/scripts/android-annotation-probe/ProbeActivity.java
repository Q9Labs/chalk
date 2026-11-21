package ai.chalk.probe;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;

public final class ProbeActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        var menu = new LinearLayout(this);
        menu.setOrientation(LinearLayout.VERTICAL);
        var permission = new Button(this);
        permission.setText("Display over other apps");
        permission.setOnClickListener(view -> startActivity(new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())
        )));
        menu.addView(permission);
        var start = new Button(this);
        start.setText("Start capture probe");
        start.setOnClickListener(view -> {
            if (!Settings.canDrawOverlays(this)) {
                permission.performClick();
                return;
            }
            var manager = getSystemService(MediaProjectionManager.class);
            startActivityForResult(manager.createScreenCaptureIntent(), 1);
        });
        menu.addView(start);
        var stop = new Button(this);
        stop.setText("Stop capture probe");
        stop.setOnClickListener(view -> stopService(new Intent(this, ProbeService.class)));
        menu.addView(stop);
        setContentView(menu);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 1 && result == RESULT_OK && data != null) {
            startForegroundService(new Intent(this, ProbeService.class).putExtra("consent", data));
        }
    }
}
