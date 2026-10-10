package com.syakyr.sudoku;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate() so the bridge exposes
        // DynamicTheme to the page before any script asks for it.
        registerPlugin(new DynamicThemePlugin());
        super.onCreate(savedInstanceState);
    }
}
