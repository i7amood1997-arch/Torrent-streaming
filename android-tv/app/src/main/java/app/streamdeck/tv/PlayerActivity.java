package app.streamdeck.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The TV's own player (Media3 ExoPlayer) for files the WebView can't decode: MKV with
 * Dolby/DTS audio, 10-bit video and so on. Plays the link with the app's subtitles
 * (already synced), resumes where the web player was, and reports the position back.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {
    public static final String EXTRA_REQUEST = "request";

    private ExoPlayer player;
    private PlayerView view;
    private long lastPosition;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url;
        String title;
        double position;
        String primaryLang = null;
        List<MediaItem.SubtitleConfiguration> subtitles = new ArrayList<>();
        try {
            JSONObject req = new JSONObject(getIntent().getStringExtra(EXTRA_REQUEST));
            url = req.getString("url");
            title = req.optString("title", "");
            position = req.optDouble("position", 0);
            JSONArray subs = req.optJSONArray("subtitles");
            for (int i = 0; subs != null && i < subs.length(); i++) {
                JSONObject s = subs.getJSONObject(i);
                String lang = s.getString("lang");
                File f = new File(getCacheDir(), "subtitle-" + lang + ".vtt");
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(s.getString("vtt").getBytes(StandardCharsets.UTF_8));
                }
                boolean primary = s.optBoolean("primary", false);
                if (primary) primaryLang = lang;
                subtitles.add(new MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLanguage(lang)
                        .setLabel(s.optString("label", lang))
                        .setSelectionFlags(primary ? C.SELECTION_FLAG_DEFAULT : 0)
                        .build());
            }
        } catch (Exception e) {
            Toast.makeText(this, "Couldn’t open this video.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this).setEnableDecoderFallback(true);
        player = new ExoPlayer.Builder(this, renderers).build();
        if (primaryLang != null) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setPreferredTextLanguage(primaryLang)
                    .build());
        }

        view = new PlayerView(this);
        view.setBackgroundColor(Color.BLACK);
        view.setPlayer(player);
        view.setShowSubtitleButton(true);
        view.setKeepScreenOn(true);
        view.setControllerShowTimeoutMs(3500);
        SubtitleView sv = view.getSubtitleView();
        if (sv != null) {
            sv.setStyle(new CaptionStyleCompat(Color.WHITE, 0x8C000000, Color.TRANSPARENT,
                    CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, Color.BLACK, Typeface.DEFAULT_BOLD));
            sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * 1.15f);
        }
        setContentView(view);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Toast.makeText(PlayerActivity.this, "This TV can’t play this file (" + error.getErrorCodeName() + "). Try another release.", Toast.LENGTH_LONG).show();
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) finish();
            }
        });

        MediaItem item = new MediaItem.Builder()
                .setUri(url)
                .setMediaMetadata(new MediaMetadata.Builder().setTitle(title).build())
                .setSubtitleConfigurations(subtitles)
                .build();
        player.setMediaItem(item);
        if (position > 0) player.seekTo((long) (position * 1000));
        player.prepare();
        player.setPlayWhenReady(true);
        view.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Remote keys drive the player controls (seek, play/pause); Back still leaves.
        if (event.getKeyCode() != KeyEvent.KEYCODE_BACK && view != null && view.dispatchKeyEvent(event)) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void finish() {
        if (player != null) lastPosition = player.getCurrentPosition();
        Intent result = new Intent();
        result.putExtra("position", lastPosition);
        setResult(RESULT_OK, result);
        super.finish();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) {
            lastPosition = player.getCurrentPosition();
            player.setPlayWhenReady(false);
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (player != null) player.setPlayWhenReady(true);
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
