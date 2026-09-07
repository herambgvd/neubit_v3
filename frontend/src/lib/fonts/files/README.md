# Bundled typefaces

The latin subset of each family's variable face, taken from Google Fonts and
committed so the build never needs the public internet (air-gapped installs).

All six are licensed under the **SIL Open Font License 1.1**, which permits
bundling and redistribution inside a product. The licence text ships with each
family upstream:

| File                  | Family         | Upstream                                        |
| --------------------- | -------------- | ----------------------------------------------- |
| `outfit.woff2`        | Outfit         | https://fonts.google.com/specimen/Outfit         |
| `inter.woff2`         | Inter          | https://fonts.google.com/specimen/Inter          |
| `dm-sans.woff2`       | DM Sans        | https://fonts.google.com/specimen/DM+Sans        |
| `public-sans.woff2`   | Public Sans    | https://fonts.google.com/specimen/Public+Sans    |
| `jetbrains-mono.woff2`| JetBrains Mono | https://fonts.google.com/specimen/JetBrains+Mono |

Geist is not here — it arrives as a package dependency (`geist`), also OFL.

To refresh one, fetch the `/* latin */` block's `.woff2` from the `css2` API with
a modern browser User-Agent; anything older is served as TTF and is ~4x larger.
