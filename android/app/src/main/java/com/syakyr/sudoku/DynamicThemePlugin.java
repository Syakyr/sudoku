package com.syakyr.sudoku;

import android.app.Activity;
import android.content.Context;
import android.content.res.TypedArray;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.material.color.DynamicColors;

/**
 * Exposes Android's Material You dynamic colors to the web layer.
 *
 * The WebView cannot read native colors, so this is the only bridge. Reached
 * from JS through the global Capacitor bridge (see js/material-you.js) rather
 * than an npm package -- this project ships raw ES modules with no bundler, so
 * a bare specifier could not resolve at runtime anyway. Same shape as
 * js/native-storage.js.
 *
 * We deliberately return the SEED HUE rather than a palette. The app's four
 * hand-tuned themes are all HSL with a consistent saturation/lightness recipe
 * per mode, so regenerating the whole theme from one hue reuses a recipe that
 * already has verified contrast. Pushing raw Material ARGB values across and
 * tinting them in JS would throw that away and produce unreadable pencil marks.
 *
 * Everything here is fail-safe by design: if dynamic color is unavailable, the
 * plugin reports supported=false and the UI never shows the Dynamic option.
 */
@CapacitorPlugin(name = "DynamicTheme")
public class DynamicThemePlugin extends Plugin {

    @PluginMethod
    public void getColors(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", false);

        // Dynamic color is Android 12 (API 31) and up. minSdk here is 24, so
        // most of the supported range lands in this branch and the swatch is
        // simply never offered.
        if (Build.VERSION.SDK_INT < 31) {
            ret.put("reason", "android_version");
            call.resolve(ret);
            return;
        }

        try {
            Activity activity = getActivity();
            if (activity == null) {
                ret.put("reason", "no_activity");
                call.resolve(ret);
                return;
            }

            if (!DynamicColors.isDynamicColorAvailable()) {
                ret.put("reason", "unavailable_on_device");
                call.resolve(ret);
                return;
            }

            // wrapContextIfAvailable applies the dynamic overlay, so the attrs
            // read back are the wallpaper-derived ones rather than the static
            // theme values. Reading the attrs off the raw activity would return
            // the app's own theme colors and look "supported" while being wrong.
            Context ctx = DynamicColors.wrapContextIfAvailable(activity);
            TypedArray ta = ctx.obtainStyledAttributes(
                    new int[]{com.google.android.material.R.attr.colorPrimary});
            int argb = ta.getColor(0, 0);
            ta.recycle();

            if (argb == 0) {
                ret.put("reason", "no_seed_color");
                call.resolve(ret);
                return;
            }

            ret.put("supported", true);
            ret.put("sdkInt", Build.VERSION.SDK_INT);
            // Raw seed, kept for debugging; the web layer derives the hue itself.
            ret.put("colorPrimary", String.format("#%06X", 0xFFFFFF & argb));
            call.resolve(ret);
        } catch (Throwable t) {
            // Any failure on the native side degrades to "not supported" rather
            // than breaking app startup.
            ret.put("supported", false);
            ret.put("reason", "error");
            ret.put("message", t.getClass().getSimpleName());
            call.resolve(ret);
        }
    }
}
