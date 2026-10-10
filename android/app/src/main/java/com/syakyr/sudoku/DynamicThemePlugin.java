package com.syakyr.sudoku;

import android.app.Activity;
import android.content.Context;
import android.content.res.Resources;
import android.graphics.Color;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes Android's Material You dynamic colors to the web layer.
 *
 * The WebView cannot read native colors, so this is the only bridge. Reached
 * from JS through the global Capacitor bridge (see js/material-you.js) rather
 * than an npm package -- this project ships raw ES modules with no bundler, so
 * a bare specifier could not resolve at runtime anyway. Same shape as
 * js/native-storage.js.
 *
 * We deliberately return the SEED COLOR and let the web layer derive the hue.
 * The app's four hand-tuned themes are all HSL with a consistent
 * saturation/lightness recipe per mode, so regenerating the whole theme from one
 * hue reuses a recipe that already has verified contrast. Pushing a full
 * Material palette across and tinting it in JS would throw that away and produce
 * unreadable pencil marks.
 *
 * WHY PLATFORM RESOURCES AND NOT com.google.android.material
 * Android 12 ships the Material You palette as *platform* color resources.
 * Verified against developer.android.com/reference/android/R.color: all 13
 * tones exist -- system_accent1_{0,10,50,100,200,300,400,500,600,700,800,
 * 900,1000} -- and the AOSP dynamic-color doc confirms the naming scheme
 * ("five tonal palettes ... 13 color values ... For example:
 * R.color#system_accent1_10").
 *
 * Reading those means no Material Components dependency at all -- smaller APK,
 * one less thing to version. The lookup is done by name via getIdentifier()
 * rather than as a compile-time constant, so this compiles against any
 * compileSdk and degrades to "unsupported" at runtime if the resource is
 * genuinely absent, instead of failing the build.
 *
 * CAVEAT from the AOSP docs: devices integrate this feature behind a
 * "hardcoded allowlist", and on API levels or devices where the tonal palettes
 * are not wired up, these resources can resolve to the *baseline* palette
 * rather than a wallpaper-derived one. So "supported" here means "we got a
 * color", not "the color is definitely dynamic". There is no public API to
 * distinguish the two, so the swatch label says "derived from your wallpaper"
 * and a user on such a device would simply get a fixed palette that looks
 * intentional.
 *
 * Everything here is fail-safe by design: if dynamic color is unavailable the
 * plugin reports supported=false and the UI never shows the Dynamic option.
 */
@CapacitorPlugin(name = "DynamicTheme")
public class DynamicThemePlugin extends Plugin {

    /** Tone 500 is the Material You "primary" step of the accent1 ramp. */
    private static final String SEED_RESOURCE = "system_accent1_500";

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

            Resources res = activity.getResources();
            // Looked up by name in the "android" (framework) package. Returns 0
            // if the resource does not exist on this device.
            int resId = res.getIdentifier(SEED_RESOURCE, "color", "android");
            if (resId == 0) {
                ret.put("reason", "no_seed_resource");
                call.resolve(ret);
                return;
            }

            int argb = activity.getColor(resId);
            // A fully transparent result means we got nothing usable.
            if (Color.alpha(argb) == 0) {
                ret.put("reason", "no_seed_color");
                call.resolve(ret);
                return;
            }

            ret.put("supported", true);
            ret.put("sdkInt", Build.VERSION.SDK_INT);
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
