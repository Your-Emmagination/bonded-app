# BondED logo and app icon

The logo (the woven knot) and the app icon are **generated** from the original
artwork in `source/`. Don't edit the images in `assets/images/` by hand — run
the script instead, then rebuild the app.

## Change the colours

```
pip install pillow numpy          # once
python scripts/brand/build-brand-assets.py --logo campus --icon maroon
```

Then rebuild the APK — app icons only change in a new build.

| `--logo`     | Look                                             |
|--------------|--------------------------------------------------|
| `campus`     | Two gold ribbons, one maroon, one cream *(live)* |
| `heritage`   | Original greys; navy → maroon, mint → gold       |
| `warm`       | Heritage with warm greys                         |
| `cream`      | Light ribbons, made for maroon screens           |
| `gold`       | Four tones of gold                               |
| `maroon`     | Four tones of maroon (weak on maroon screens)    |
| `collegiate` | Maroon, navy and gold                            |
| `festival`   | Gold, crimson and amber                          |
| `original`   | The logo exactly as it was                       |

| `--icon`   | Look                                  |
|------------|---------------------------------------|
| `maroon`   | Maroon, cream bubble, gold cap *(live)* |
| `sunset`   | Gold fading into maroon               |
| `gold`     | Bright gold                           |
| `night`    | Deep maroon, gold bubble              |
| `cream`    | Light cream                           |
| `original` | The teal-and-purple icon as it was    |

To add a colourway, add an entry to `palettes.json` and run the script with
its name.

## What it writes

- `assets/images/BondEDlogo.png` — the knot alone. The name "BondED" is text,
  from `app/(main)/components/BrandWordmark.tsx`, so it is never printed twice.
- `assets/images/splash-icon.png` — the knot on the launch screen.
- `assets/images/icon.png`, `favicon.png` — the app icon.
- `assets/images/android-icon-foreground/background/monochrome.png` — the
  Android adaptive icon, sized to survive round and squircle launchers.
- `utils/brand.generated.ts` — which colourway is live, so the "ED" in the
  wordmark matches the logo.

## A completely new logo

If the team picks a new design (the Link, the Crest…), export it as PNGs to
the same file names and set `wordmarkAccent` in `utils/brand.generated.ts`.
Nothing else in the app refers to the logo.
