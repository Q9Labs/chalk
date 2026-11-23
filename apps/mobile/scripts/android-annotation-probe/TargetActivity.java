package ai.chalk.probe;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.view.View;

public final class TargetActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(new View(this) {
            private final Paint paint = new Paint();

            @Override
            protected void onDraw(Canvas canvas) {
                canvas.drawColor(Color.rgb(80, 210, 230));
                paint.setColor(Color.rgb(32, 84, 102));
                canvas.drawRect(0, 0, getWidth() * .18f, getHeight(), paint);
                canvas.drawRect(getWidth() * .78f, 0, getWidth(), getHeight() * .16f, paint);
                // Keep the projection producing frames without moving the fiducials.
                float pulse = (android.os.SystemClock.uptimeMillis() % 1000) / 1000f;
                canvas.drawRect(0, getHeight() * .97f, getWidth() * .1f * pulse, getHeight(), paint);
                postInvalidateDelayed(200);
            }
        });
    }
}
