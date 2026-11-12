package com.daygrid.app;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Locale;

/**
 * 日格 Android 壳：
 * 起一个只监听 127.0.0.1 的静态服务器，把 assets/www 里的页面喂给 WebView。
 * 这样 IndexedDB、fetch 都能正常工作（file:// 下 IndexedDB 不可靠）。
 */
public class MainActivity extends Activity {

    private WebView web;
    private ServerSocket socket;
    private int port = 8788;
    private Thread serverThread;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 21) {
            window.setStatusBarColor(0xFFFBFAF7);
            window.setNavigationBarColor(0xFFFBFAF7);
            window.getDecorView().setSystemUiVisibility(0x2000); // LIGHT_STATUS_BAR
        }

        startServer();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " DayGrid/0.1");
        web.setWebViewClient(new WebViewClient());
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        setContentView(web);
        web.loadUrl("http://127.0.0.1:" + port + "/");
    }

    private void startServer() {
        for (int p = 8788; p < 8800; p++) {
            try {
                socket = new ServerSocket(p, 50, InetAddress.getByName("127.0.0.1"));
                port = p;
                break;
            } catch (IOException ignored) {
            }
        }
        if (socket == null) return;
        serverThread = new Thread(new Runnable() {
            @Override
            public void run() {
                while (!socket.isClosed()) {
                    try (Socket c = socket.accept()) {
                        handle(c);
                    } catch (IOException e) {
                        break;
                    }
                }
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void handle(Socket c) throws IOException {
        c.setSoTimeout(5000);
        InputStream in = c.getInputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b;
        int state = 0;
        while ((b = in.read()) != -1) {
            head.write(b);
            if (b == '\r' && (state == 0 || state == 2)) state++;
            else if (b == '\n' && (state == 1 || state == 3)) {
                state++;
                if (state == 4) break;
            } else state = 0;
        }
        String first = new String(head.toByteArray(), "UTF-8").split("\r\n")[0];
        String[] parts = first.split(" ");
        String path = parts.length > 1 ? parts[1] : "/";
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path.equals("/")) path = "/index.html";
        if (path.contains("..")) path = "/index.html";

        String asset = "www" + path;
        OutputStream out = c.getOutputStream();
        try (InputStream is = getAssets().open(asset)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            byte[] data = bos.toByteArray();
            String header = "HTTP/1.1 200 OK\r\nContent-Type: " + mime(path)
                    + "\r\nContent-Length: " + data.length
                    + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
            out.write(header.getBytes("UTF-8"));
            out.write(data);
        } catch (IOException e) {
            byte[] body = "Not found".getBytes("UTF-8");
            String header = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n";
            out.write(header.getBytes("UTF-8"));
            out.write(body);
        }
        out.flush();
    }

    private String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
