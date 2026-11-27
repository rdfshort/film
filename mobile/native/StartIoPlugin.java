package com.reeldramafilm.app;

import android.app.Activity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.startapp.sdk.adsbase.Ad;
import com.startapp.sdk.adsbase.StartAppAd;
import com.startapp.sdk.adsbase.StartAppSDK;
import com.startapp.sdk.adsbase.adlisteners.AdDisplayListener;
import com.startapp.sdk.adsbase.adlisteners.AdEventListener;

/** Small bridge to the Start.io (StartApp) interstitial ad. JS name: StartIo. */
@CapacitorPlugin(name = "StartIo")
public class StartIoPlugin extends Plugin {
    private StartAppAd ad;
    private boolean inited = false;
    private boolean ready = false;

    @PluginMethod
    public void initialize(final PluginCall call) {
        final String appId = call.getString("appId", "");
        final boolean testing = Boolean.TRUE.equals(call.getBoolean("testing", false));
        final Activity act = getActivity();
        if (appId == null || appId.isEmpty() || act == null) { call.reject("Start.io: missing app id"); return; }
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (!inited) {
                        StartAppSDK.setTestAdsEnabled(testing);
                        StartAppSDK.init(act, appId, false);
                        StartAppAd.disableSplash();
                        inited = true;
                    }
                    call.resolve();
                } catch (Throwable t) { call.reject("Start.io init failed: " + t); }
            }
        });
    }

    @PluginMethod
    public void load(final PluginCall call) {
        final Activity act = getActivity();
        if (!inited || act == null) { call.reject("Start.io: not initialised"); return; }
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (ready && ad != null) { call.resolve(); return; }
                    ad = new StartAppAd(act);
                    ad.loadAd(new AdEventListener() {
                        @Override public void onReceiveAd(Ad a) { ready = true; call.resolve(); }
                        @Override public void onFailedToReceiveAd(Ad a) { ready = false; call.reject("Start.io: no ad available"); }
                    });
                } catch (Throwable t) { ready = false; call.reject("Start.io load failed: " + t); }
            }
        });
    }

    @PluginMethod
    public void show(final PluginCall call) {
        final Activity act = getActivity();
        if (!inited || !ready || ad == null || act == null) { call.reject("Start.io: no ad is ready"); return; }
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                final boolean[] done = { false };
                try {
                    ready = false;
                    boolean started = ad.showAd(new AdDisplayListener() {
                        @Override public void adHidden(Ad a) { finish(true); }
                        @Override public void adDisplayed(Ad a) { }
                        @Override public void adClicked(Ad a) { }
                        @Override public void adNotDisplayed(Ad a) { finish(false); }
                        private void finish(boolean shown) {
                            if (done[0]) return; done[0] = true;
                            JSObject r = new JSObject(); r.put("shown", shown); call.resolve(r);
                        }
                    });
                    if (!started && !done[0]) { done[0] = true; JSObject r = new JSObject(); r.put("shown", false); call.resolve(r); }
                } catch (Throwable t) { if (!done[0]) { done[0] = true; call.reject("Start.io show failed: " + t); } }
            }
        });
    }
}
