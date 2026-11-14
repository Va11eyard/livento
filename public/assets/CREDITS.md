# Livento media credits

All trail and category images are free-licensed stock media, downloaded on
**2026-11-14**. Attribution is not required by either license; we give it anyway.
Exact source URLs, byte sizes, SHA-256 hashes and the ffmpeg commands used for
every file are recorded in [`assets.json`](./assets.json) and re-checked with
`npm run assets` (add `-- --sources` to re-download and verify each source).

None of the media shows an identifiable performer, and none was chosen for a logo
or trademark. Screens and banners in these images carry no readable text or logos.

## Photos (`/assets/trail/*.webp`)

| File | Shows | Photographer | Source page | License |
|---|---|---|---|---|
| `concert.webp` | Crowd silhouettes under warm stage lights | Nainoa Shizuru | https://unsplash.com/photos/concert-photos-NcdG9mK3PBY | [Unsplash License](https://unsplash.com/license) |
| `theatre.webp` | Three performer silhouettes in front of a red curtain | Kyle Head | https://unsplash.com/photos/silhouette-of-three-performers-on-stage-p6rNTdAPbuk | [Unsplash License](https://unsplash.com/license) |
| `festival.webp` | Outdoor festival crowd at golden hour | Barney Goodman | https://unsplash.com/photos/crowd-watching-band-at-music-festival-TRY69Sky9IQ | [Unsplash License](https://unsplash.com/license) |
| `cinema.webp` | Audience facing a lit screen in a vintage cinema | Jake Hills | https://unsplash.com/photos/cinema-audience-in-dark-theater-23LET4Hxj_U | [Unsplash License](https://unsplash.com/license) |

**Modifications:** downloaded at 1600 px wide (JPEG), centre-cropped from 3:2 to
4:3, resized to 800×600, converted to WebP (quality 80).

## Animated loops (`/assets/trail/loop-*.gif`) and posters (`loop-*.webp`)

| Files | Shows | Creator | Source page | License |
|---|---|---|---|---|
| `loop-1.gif`, `loop-1.webp` | Stage light beam through fog | Sergei Starostin | https://www.pexels.com/video/dynamic-stage-lighting-with-fog-effects-39472140/ | [Pexels License](https://www.pexels.com/license/) |
| `loop-2.gif`, `loop-2.webp` | Confetti over a concert crowd | Belén Montero | https://www.pexels.com/video/energetic-night-concert-with-confetti-34636825/ | [Pexels License](https://www.pexels.com/license/) |
| `loop-3.gif`, `loop-3.webp` | Vinyl record spinning | Atakan Ozkan | https://www.pexels.com/video/vinyl-record-spinning-3116508/ | [Pexels License](https://www.pexels.com/license/) |

**Modifications:** made from the original video files with ffmpeg:

- `loop-1`: 3 s from 0:05.4, 12 fps.
- `loop-2`: the first 2 s, 10 fps, light blur.
- `loop-3`: 1.75 s from 0:05 (one record turn, so it loops seamlessly), 12 fps.

Each was cropped to 384×336, denoised and converted to an animated GIF with a
42–64 color palette (palettegen/paletteuse). Each `.webp` poster is the first
frame of its loop and replaces the GIF when the visitor asks for reduced motion.

## Fonts (`/assets/fonts`)

Inter, Oswald and TASA Orbiter are used under the SIL Open Font License 1.1. The
font files come from the Loop Dept design reference. Each font's license text is
in [`/assets/licenses`](./licenses/).
