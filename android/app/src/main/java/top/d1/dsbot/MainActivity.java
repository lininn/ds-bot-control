// The phone app is a window onto the page the relay serves (the same shell a browser opens):
// one WebView, the relay address kept on the device, the page's own cookies for the sign-in.
package top.d1.dsbot;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "https://ds.d-1.top";
    private static final String PREFS = "shell";
    private static final String KEY_URL = "relay";
    private static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> picked;
    // The origin the app treats as its own; anything else opens in the browser.
    private String home = "";
    // One error dialog at a time: a failing page reports the main frame once, but a retry loop
    // would stack the dialogs.
    private boolean reported;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0f1115"));
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DSBotAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        String saved = prefs().getString(KEY_URL, null);
        if (state != null) {
            web.restoreState(state);
        } else if (saved == null) {
            // First run: show the address once, so a relay on this network is one field away.
            editAddress(DEFAULT_URL, true);
        } else {
            open(saved);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void editAddress(String prefill, boolean firstRun) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefill);
        input.setSelection(prefill.length());
        new AlertDialog.Builder(this)
                .setTitle(R.string.address_title)
                .setView(input)
                .setPositiveButton(R.string.address_save, (dialog, which) -> open(input.getText().toString()))
                .setNegativeButton(android.R.string.cancel,
                        (dialog, which) -> { if (firstRun) open(DEFAULT_URL); })
                .show();
    }

    private void open(String raw) {
        String url = raw.trim();
        if (url.isEmpty()) url = DEFAULT_URL;
        if (!url.matches("(?i)^https?://.*")) url = "https://" + url;
        Uri uri = Uri.parse(url);
        home = origin(uri);
        reported = false;
        prefs().edit().putString(KEY_URL, url).apply();
        web.loadUrl(url);
    }

    private static String origin(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        int port = uri.getPort();
        return scheme + "://" + uri.getHost() + (port > 0 ? ":" + port : "");
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // Nothing on the device handles this link; the page stays where it is.
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if ((scheme.equals("http") || scheme.equals("https")) && origin(uri).equals(home)) {
                return false;
            }
            openOutside(uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            reported = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || reported) return;
            reported = true;
            String address = web.getUrl() == null ? DEFAULT_URL : web.getUrl();
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.error_title)
                    .setMessage(String.valueOf(error.getDescription()))
                    .setPositiveButton(R.string.error_retry, (dialog, which) -> web.reload())
                    .setNeutralButton(R.string.error_address, (dialog, which) -> editAddress(address, false))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
        }
    }

    // The chat's attach button asks the page for a file; the page's own picker is not reachable
    // from a WebView, so the activity answers it.
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (picked != null) picked.onReceiveValue(null);
            picked = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(intent, getString(R.string.pick_file)), PICK_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                picked = null;
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK_FILE || picked == null) {
            super.onActivityResult(request, result, data);
            return;
        }
        picked.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        picked = null;
    }
}
