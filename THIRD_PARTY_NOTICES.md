# Third-party notices

## Native Node.js runtime

Native release archives include the official Node.js 24.22.1 Linux x64 distribution, verified against a pinned SHA-256 before packaging and installation. Its LICENSE file and bundled third-party notices are retained inside the runtime archive. Source: https://nodejs.org/dist/v24.22.1/ . The runtime is extracted into the panel's own directory; system Node.js is not replaced.

## DMP web

Repository: https://github.com/miracleEverywhere/dst-management-platform-web

Source snapshot: `6c18f3668a14953216ad44ef8f813e86d9031a18`.

Copyright (c) 2024 Miracle. MIT license: `licenses/DMP-web-MIT.txt`.

The following upstream files are preserved in `vendor/` and included in the inline browser bundle in `index.html`:

- `src/views/game/components/base/levelDataMap.js`: world setting definitions, options, translations and groups.
- `src/views/game/components/base/leveldataoverride.js`: Lua presets for seven game modes.
- `src/views/game/components/base/levelDataOverrides.js`: AST based Lua override reading and replacement.

`vendor/dmp-browser.js` packages these files with luaparse for a standalone HTML page. The room and mod UI is an adaptation for FeatherPanel, not a verbatim copy of DMP's Vue components. Workshop method names and parameter formats were checked against DMP's `src/api/mod.js`.

The 231 images in `assets/world-icons/` were copied from upstream `gameSettingImages/`. Game artwork and trademarks remain the property of their respective rights holders, including Klei Entertainment; the code license does not assert ownership of those assets.

The world editor's visual/Lua mode workflow follows DMP's world.vue. FeatherPanel uses a native text editor with line numbers, per-world source state and static Lua diagnostics; DMP's Vue/CodeMirror component is not bundled. The validateLevelData helper is a FeatherPanel addition. Both modes preserve comments and custom static data through the upstream AST helpers.

## DMP API reference and default game token

The console world table follows DMP web's dashboard/index.vue workflow: independent world power switches and CPU/memory columns. FeatherPanel supplies its own DOM/CSS, authenticated task routes and Linux process sampling; no DMP monitoring component or service is required.

Backend room/INI/SteamCMD conventions were checked against the archived DMP API source. `backend/src/upstream-default.mjs` adapts the default-token decoder and obfuscated default Steam API key from `utils/getter.go`; the upstream MIT license and copyright are retained in `licenses/DMP-api-MIT.txt` (Copyright (c) 2024 Miracle). The defaults can be replaced with FEATHER_CLUSTER_TOKEN and FEATHER_STEAM_API_KEY.

## luaparse

Version: 0.3.1. Repository: https://github.com/fstirlitz/luaparse

MIT license and copyright notice: `licenses/luaparse-MIT.txt`.

Bundled into `vendor/dmp-browser.js` and the inline world data script in `index.html`.

## Supplied design and wallpaper

The page design and `wallpaper.mp4` were supplied by the user. No ownership or redistribution rights are asserted by this project.



玩家角色头像来自 DMP web 的 src/views/tools/images（assets/characters）。DMP 代码授权见 licenses/DMP-web-MIT.txt；角色形象属于 Klei Entertainment。

## Island Adventures world customization artwork

The 187 PNG images under `assets/world-icons/shipwrecked/`, `porkland/` and `core/` are cropped from the installed mods' customization atlases. Sources: Island Adventures Shipwrecked (Workshop 1467214795, `images/hud/customization_shipwrecked`), the supplied Hamlet/Porkland package (Workshop 3782535279, `images/hud/customization_porkland`) and Island Adventures Core (Workshop 3435352667, `images/hud/customization_core`). They are normalized to a 96×96 transparent canvas; mappings follow static configuration declarations. No mod Lua is executed and no gameplay code is included by this change. Game and mod artwork belongs to its respective rights holders, including Klei Entertainment and the mod creators; the panel code license does not grant ownership of these images.
