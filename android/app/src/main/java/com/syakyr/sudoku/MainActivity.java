package com.syakyr.sudoku;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Capacitor's registerPlugin takes the Class, not an instance -- passing
        // `new DynamicThemePlugin()` fails to compile with
        // "incompatible types: DynamicThemePlugin cannot be converted to
        // Class<? extends Plugin>". Must be registered before super.onCreate()
        // so the bridge exposes DynamicTheme before any page script asks.
        registerPlugin(DynamicThemePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
