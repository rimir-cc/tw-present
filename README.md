# tw-present

Fullscreen slide player for TiddlyWiki. Renders any filter-driven set of tiddlers as a slide deck with reveal.js-style 2D navigation (left/right between sections, up/down between slides within a section), link-driven deep-dive with a breadcrumb that pops you back, and a pluggable layout system.

## Key features

- **Filter-parameterized** — pass any filter that yields slide-tiddler titles in order. Not coupled to any specific content model.
- **2D navigation** — `←/→` walks horizontally between sections; `↑/↓` walks vertically between slides within the current section.
- **Deep-dive breadcrumb** — clicking a wikitext link inside a slide pushes the current location and renders the linked tiddler as an ad-hoc slide. The breadcrumb above the slide shows where you came from; click any segment to pop back.
- **Pluggable layouts** — `mm.slide-layout` on each slide selects a layout template under `$:/plugins/rimir/present/layouts/`. Ships with `default`, `title`, `two-column`, `quote`, `image`, `full`. Add your own by creating a layout tiddler.
- **Notes + help** — `N` toggles presenter notes (configurable field); `?` shows the keyboard reference.
- **Engine-agnostic** — companion plugins (such as `rimir/mindmap`) supply the filter via a wikitext op; this plugin just plays.

## Prerequisites

- TiddlyWiki 5.3.0+
- Optional: `rimir/theme` for shared `rr-` style hooks
- Optional: `rimir/doc-template` for the branded documentation tab

## Quick start

```
<$present
    slides="[tag[Slides]]"
    section-field="mm.slide-of"
    layout-field="mm.slide-layout"
    caption-field="caption"
    notes-field="mm.slide-notes"
    title="My deck"
/>
```

Wrap in `$reveal` to gate the overlay on a state tiddler if you want a button to "play" the deck.

## License

MIT.
