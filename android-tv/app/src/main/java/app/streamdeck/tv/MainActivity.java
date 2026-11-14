package app.streamdeck.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Streamdeck for Android TV: the web app full screen in a WebView, driven by the remote.
 * The page does its own focus navigation (lib/tv.ts); this activity forwards Back to it,
 * shows HTML5 fullscreen video, and opens files the WebView can't decode in PlayerActivity.
 */
public class MainActivity extends Activity {
    private static final int REQ_PLAYER = 1;
    private static final String APP_URL = BuildConfig.APP_URL;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private WebChromeClient chrome;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " StreamdeckTV/" + BuildConfig.VERSION_NAME);

        // Smoother scrolling: draw a little beyond the screen ahead of time, and give the
        // page's renderer priority while the app is in front.
        if (android.os.Build.VERSION.SDK_INT >= 23) s.setOffscreenPreRaster(true);
        if (android.os.Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);

        web.addJavascriptInterface(new Bridge(), "StreamdeckTV");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(APP_URL)) showOffline();
            }
        });
        chrome = new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                view.requestFocus();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                web.requestFocus();
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // No grey "play" placeholder before a video starts.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        };
        web.setWebChromeClient(chrome);

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(APP_URL);
        web.requestFocus();
    }

    /** Links to other sites open in another app (if there is one); the app's own pages stay here. */
    private boolean openOutside(Uri uri) {
        String url = uri.toString();
        if (url.startsWith(APP_URL) || "about".equals(uri.getScheme()) || "data".equals(uri.getScheme())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No browser on this TV.
        }
        return true;
    }

    private void showOffline() {
        String html = "<html><body style='margin:0;background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>"
                + "<div><h1 style='font-size:28px'>Can’t reach Streamdeck</h1>"
                + "<p style='color:#999;font-size:16px'>Check the TV’s internet connection, then try again.</p>"
                + "<button autofocus onclick='StreamdeckTV.retry()' style='margin-top:16px;font-size:18px;padding:12px 32px;border-radius:12px;border:0;background:#fff;color:#000'>Try again</button>"
                + "</div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // The remote's centre button reaches the page as Enter, which clicks the focused control.
        int code = event.getKeyCode();
        if (customView == null && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
            KeyEvent enter = new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(), KeyEvent.KEYCODE_ENTER,
                    event.getRepeatCount(), event.getMetaState(), event.getDeviceId(), event.getScanCode(), event.getFlags(), event.getSource());
            return web.dispatchKeyEvent(enter);
        }
        return super.dispatchKeyEvent(event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (customView != null) { chrome.onHideCustomView(); return; }
        // Let the page step back (close a sheet, leave the player, a title…); leave the app when it can't.
        web.evaluateJavascript("(window.__tvBack && window.__tvBack()) ? '1' : '0'", value -> {
            if (!"\"1\"".equals(value)) finish();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PLAYER) return;
        double seconds = data != null ? data.getLongExtra("position", 0) / 1000.0 : 0;
        web.evaluateJavascript("window.__tvNativeClosed && window.__tvNativeClosed(" + seconds + ")", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** Called from the page (window.StreamdeckTV). */
    private class Bridge {
        @JavascriptInterface
        public void playNative(String json) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra(PlayerActivity.EXTRA_REQUEST, json);
                startActivityForResult(i, REQ_PLAYER);
            });
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> web.loadUrl(APP_URL));
        }
    }
}
