/*\
title: $:/plugins/rimir/present/widget.js
type: application/javascript
module-type: widget

The $present widget — fullscreen slide player.

Renders a fixed-position fullscreen overlay over an ordered set of slide
tiddlers supplied by a `slides=` filter. Slides are grouped into //sections//
by a configurable field (default `mm.slide-of`); navigation is 2D:

   ← / →    move between sections (one section = one vertical stack)
   ↑ / ↓    move between slides within the current section
   Space    advance (next vertical → wrap to next section)
   Backspc  reverse advance
   Home/End first / last slide of deck
   Esc      close the overlay (or pop the navigation stack — see below)
   N        toggle presenter-notes overlay
   ?        toggle keyboard cheat sheet

Per-slide layout is dispatched by reading `<layout-field>` (default
`mm.slide-layout`) and transcluding `$:/plugins/rimir/present/layouts/<name>`
with `currentTiddler` set to the slide. Falls back to `default` when the
named layout doesn't exist.

Deep-dive: when the user clicks a wikitext link inside a slide, the click is
intercepted (preventDefault), the current location pushed onto a
navigation stack, and the linked tiddler is rendered in place as an ad-hoc
slide with layout `default`. The breadcrumb at the top reflects the stack;
clicking any segment pops back. Esc pops one level when the stack is
non-empty, only closing the overlay once everything has been popped.

The widget owns its DOM directly (not a wikitext widget tree) so we can
attach document-level key listeners cleanly and avoid TW refresh ping-pong
on every keystroke. Slide //content// is still rendered via TW's transclude
machinery so layouts can be ordinary wikitext templates.

\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

var LAYOUT_PREFIX = "$:/plugins/rimir/present/layouts/";
var DEFAULT_LAYOUT = "default";
var DEFAULT_SECTION_FIELD = "mm.slide-of";
var DEFAULT_LAYOUT_FIELD = "mm.slide-layout";
var DEFAULT_CAPTION_FIELD = "caption";
var DEFAULT_NOTES_FIELD = "mm.slide-notes";
var ESC_CONFIG = "$:/config/rimir/present/no-esc-close";

function trim(s) { return (s || "").replace(/^\s+|\s+$/g, ""); }

function PresentWidget(parseTreeNode, options) {
    this.initialise(parseTreeNode, options);
}

PresentWidget.prototype = new Widget();

PresentWidget.prototype.render = function (parent, nextSibling) {
    this.parentDomNode = parent;
    this.computeAttributes();
    this.execute();

    // Top-level container. Rendered into the parent dom node; positioned via
    // CSS to cover the viewport. Renders empty if no slides resolved.
    var root = this.document.createElement("div");
    root.className = "rr-present-root";
    parent.insertBefore(root, nextSibling);
    this.rootDom = root;
    this.domNodes.push(root);

    this.grid = this.buildGrid();
    if (!this.grid.length) {
        var empty = this.document.createElement("div");
        empty.className = "rr-present-empty";
        empty.textContent = "(no slides to present — check the slides filter)";
        root.appendChild(empty);
        return;
    }

    // Navigation state
    this.section = this.clampSection(parseInt(this.startSection, 10) || 0);
    this.slide = this.clampSlide(this.section, parseInt(this.startSlide, 10) || 0);
    // Each entry: { kind: "grid", section: i, slide: j }
    //          or { kind: "deep", tiddler: "...", returnTo: {kind:"grid",section,slide} | prior deep entry }
    this.stack = [];
    this.deepTiddler = null;

    this.buildChrome();
    this.renderCurrent();
    this.bindEvents();
};

PresentWidget.prototype.execute = function () {
    this.slidesFilter = this.getAttribute("slides", "");
    this.sectionField = this.getAttribute("section-field", DEFAULT_SECTION_FIELD);
    this.layoutField = this.getAttribute("layout-field", DEFAULT_LAYOUT_FIELD);
    this.captionField = this.getAttribute("caption-field", DEFAULT_CAPTION_FIELD);
    this.notesField = this.getAttribute("notes-field", DEFAULT_NOTES_FIELD);
    this.deckTitle = this.getAttribute("title", "");
    this.startSection = this.getAttribute("start-section", "0");
    this.startSlide = this.getAttribute("start-slide", "0");
    this.onCloseActions = this.getAttribute("on-close-actions", "");
    this.makeChildWidgets();
};

PresentWidget.prototype.refresh = function (changedTiddlers) {
    var changedAttributes = this.computeAttributes();
    if (Object.keys(changedAttributes).length) {
        this.refreshSelf();
        return true;
    }
    // If the slides filter result changed, rebuild grid (preserve current pos
    // when possible). Simplest: refreshSelf — the widget is short-lived in
    // typical usage so this is fine.
    if (this.slidesFilter) {
        var fresh = this.buildGrid();
        if (gridSignature(fresh) !== gridSignature(this.grid)) {
            this.refreshSelf();
            return true;
        }
    }
    return this.refreshChildren(changedTiddlers);
};

function gridSignature(grid) {
    var parts = [];
    for (var i = 0; i < grid.length; i++) {
        parts.push(grid[i].key + ":" + grid[i].slides.join(","));
    }
    return parts.join("|");
}

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

PresentWidget.prototype.buildGrid = function () {
    if (!this.slidesFilter) { return []; }
    var titles = this.wiki.filterTiddlers(this.slidesFilter, this);
    return buildGrid(titles, this.wiki, this.sectionField);
};

// Exposed for unit tests. Pure function over (titles, wiki, sectionField).
// "wiki" is anything responding to .getTiddler(title) → {fields: {...}} | null.
function buildGrid(titles, wiki, sectionField) {
    var sections = [];
    var byKey = Object.create(null);
    var fallbackCounter = 0;
    for (var i = 0; i < titles.length; i++) {
        var t = titles[i];
        var tid = wiki && wiki.getTiddler ? wiki.getTiddler(t) : null;
        var key = tid && tid.fields ? trim(tid.fields[sectionField] || "") : "";
        // Empty section value → treat each such slide as its own section so
        // they don't accidentally bucket together. Stable order preserved.
        if (!key) { key = "__solo_" + (fallbackCounter++); }
        if (!byKey[key]) {
            byKey[key] = { key: key, slides: [] };
            sections.push(byKey[key]);
        }
        byKey[key].slides.push(t);
    }
    return sections;
}

PresentWidget.prototype.clampSection = function (s) {
    if (!this.grid || !this.grid.length) { return 0; }
    if (s < 0) { return 0; }
    if (s > this.grid.length - 1) { return this.grid.length - 1; }
    return s;
};

PresentWidget.prototype.clampSlide = function (section, slide) {
    var sec = this.grid[section];
    if (!sec || !sec.slides.length) { return 0; }
    if (slide < 0) { return 0; }
    if (slide > sec.slides.length - 1) { return sec.slides.length - 1; }
    return slide;
};

// ---------------------------------------------------------------------------
// Chrome (top bar + slide stage + bottom HUD + overlays)
// ---------------------------------------------------------------------------

PresentWidget.prototype.buildChrome = function () {
    var doc = this.document;
    var self = this;

    // Top bar
    this.topBar = doc.createElement("div");
    this.topBar.className = "rr-present-topbar";

    this.titleEl = doc.createElement("div");
    this.titleEl.className = "rr-present-title";
    this.titleEl.textContent = this.deckTitle || "";
    this.topBar.appendChild(this.titleEl);

    this.breadcrumbEl = doc.createElement("div");
    this.breadcrumbEl.className = "rr-present-breadcrumb";
    this.topBar.appendChild(this.breadcrumbEl);

    var actions = doc.createElement("div");
    actions.className = "rr-present-actions";

    var notesBtn = doc.createElement("button");
    notesBtn.className = "rr-present-btn rr-present-notes-btn";
    notesBtn.type = "button";
    notesBtn.title = "Toggle presenter notes (N)";
    notesBtn.textContent = "Notes";
    notesBtn.addEventListener("click", function () { self.toggleNotes(); });
    actions.appendChild(notesBtn);
    this.notesBtn = notesBtn;

    var helpBtn = doc.createElement("button");
    helpBtn.className = "rr-present-btn rr-present-help-btn";
    helpBtn.type = "button";
    helpBtn.title = "Keyboard help (?)";
    helpBtn.textContent = "?";
    helpBtn.addEventListener("click", function () { self.toggleHelp(); });
    actions.appendChild(helpBtn);

    var closeBtn = doc.createElement("button");
    closeBtn.className = "rr-present-btn rr-present-close-btn";
    closeBtn.type = "button";
    closeBtn.title = "Close (Esc)";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function () { self.close(); });
    actions.appendChild(closeBtn);

    this.topBar.appendChild(actions);
    this.rootDom.appendChild(this.topBar);

    // Stage — where the slide layout renders. Intercepts clicks for deep-dive.
    // Use capture phase so we run BEFORE TW's <$link> click handler (which
    // would otherwise navigate the story river out from under us).
    this.stage = doc.createElement("div");
    this.stage.className = "rr-present-stage";
    this.stage.addEventListener("click", function (ev) { self.handleStageClick(ev); }, true);
    this.rootDom.appendChild(this.stage);

    // Notes overlay (hidden by default)
    this.notesPanel = doc.createElement("div");
    this.notesPanel.className = "rr-present-notes-panel";
    this.notesPanel.style.display = "none";
    this.rootDom.appendChild(this.notesPanel);

    // Help overlay
    this.helpPanel = doc.createElement("div");
    this.helpPanel.className = "rr-present-help-panel";
    this.helpPanel.style.display = "none";
    this.helpPanel.innerHTML =
        "<h2>Keyboard</h2>" +
        "<table>" +
        "<tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Previous / next section</td></tr>" +
        "<tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Previous / next slide within section</td></tr>" +
        "<tr><td><kbd>Space</kbd></td><td>Advance through deck (down then right)</td></tr>" +
        "<tr><td><kbd>Backspace</kbd></td><td>Reverse</td></tr>" +
        "<tr><td><kbd>Home</kbd> <kbd>End</kbd></td><td>First / last slide</td></tr>" +
        "<tr><td><kbd>N</kbd></td><td>Toggle presenter notes</td></tr>" +
        "<tr><td><kbd>?</kbd></td><td>Toggle this help</td></tr>" +
        "<tr><td><kbd>Esc</kbd></td><td>Pop deep-dive / close overlay</td></tr>" +
        "<tr><td>Click link</td><td>Push current, navigate to linked tiddler</td></tr>" +
        "<tr><td>Click crumb</td><td>Pop back to that point</td></tr>" +
        "</table>";
    this.rootDom.appendChild(this.helpPanel);

    // Bottom HUD — counter + caption
    this.hud = doc.createElement("div");
    this.hud.className = "rr-present-hud";
    this.rootDom.appendChild(this.hud);
};

// ---------------------------------------------------------------------------
// Rendering the current slide
// ---------------------------------------------------------------------------

PresentWidget.prototype.currentSlideTitle = function () {
    if (this.deepTiddler) { return this.deepTiddler; }
    var sec = this.grid[this.section];
    if (!sec) { return null; }
    return sec.slides[this.slide] || null;
};

PresentWidget.prototype.currentLayoutTiddler = function (slideTitle) {
    var name = DEFAULT_LAYOUT;
    if (slideTitle) {
        var tid = this.wiki.getTiddler(slideTitle);
        if (tid && tid.fields) {
            name = trim(tid.fields[this.layoutField] || DEFAULT_LAYOUT) || DEFAULT_LAYOUT;
        }
    }
    // Deep-dive renders always use default layout to avoid surprising
    // formatting from an off-path tiddler that happens to carry a layout
    // field meant for a different deck.
    if (this.deepTiddler) { name = DEFAULT_LAYOUT; }
    var candidate = LAYOUT_PREFIX + name;
    if (this.wiki.getTiddler(candidate) || this.wiki.tiddlerExists(candidate)) {
        return candidate;
    }
    return LAYOUT_PREFIX + DEFAULT_LAYOUT;
};

PresentWidget.prototype.renderCurrent = function () {
    var slideTitle = this.currentSlideTitle();
    var stage = this.stage;
    // Tear down the previous slide-widget tree to release listeners / state.
    if (this.slideSubWidget && this.slideSubWidget.removeChildDomNodes) {
        this.slideSubWidget.removeChildDomNodes();
    }
    while (stage.firstChild) { stage.removeChild(stage.firstChild); }

    if (!slideTitle) {
        var empty = this.document.createElement("div");
        empty.className = "rr-present-stage-empty";
        empty.textContent = "(empty)";
        stage.appendChild(empty);
    } else {
        var layoutTiddler = this.currentLayoutTiddler(slideTitle);
        // Wikitext: render the chosen layout with currentTiddler = slide. The
        // <$tiddler> widget rebinds currentTiddler for the inner transclude.
        var wikitext =
            "<$tiddler tiddler=<<__slide__>>>" +
            "<$transclude $tiddler=<<__layout__>> $mode=\"block\"/>" +
            "</$tiddler>";
        var parser = this.wiki.parseText("text/vnd.tiddlywiki", wikitext, { parseAsInline: false });
        if (parser) {
            var sub = this.wiki.makeWidget(parser, {
                parentWidget: this,
                document: this.document,
                variables: {
                    __slide__: slideTitle,
                    __layout__: layoutTiddler
                }
            });
            sub.render(stage, null);
            this.slideSubWidget = sub;
        }
    }
    this.updateChromeState();
};

PresentWidget.prototype.updateChromeState = function () {
    this.renderBreadcrumb();
    this.renderHud();
    this.renderNotes();
};

PresentWidget.prototype.renderBreadcrumb = function () {
    var el = this.breadcrumbEl;
    while (el.firstChild) { el.removeChild(el.firstChild); }
    var self = this;
    // Always render at least the "home" segment for the deck.
    var homeBtn = this.document.createElement("button");
    homeBtn.type = "button";
    homeBtn.className = "rr-present-crumb rr-present-crumb-home";
    homeBtn.textContent = "⌂";
    homeBtn.title = "Back to deck start";
    homeBtn.addEventListener("click", function () { self.popToHome(); });
    el.appendChild(homeBtn);

    // Render any deep-dive stack entries
    var depth = this.stack.length;
    for (var i = 0; i < depth; i++) {
        var sep = this.document.createElement("span");
        sep.className = "rr-present-crumb-sep";
        sep.textContent = "›";
        el.appendChild(sep);
        var entry = this.stack[i];
        var label = entry.kind === "grid"
            ? this.labelForGridPos(entry.section, entry.slide)
            : this.labelForTiddler(entry.tiddler);
        var crumb = this.document.createElement("button");
        crumb.type = "button";
        crumb.className = "rr-present-crumb";
        crumb.textContent = label;
        crumb.title = entry.kind === "grid"
            ? "Return to this point in the deck"
            : entry.tiddler;
        var levelIdx = i;
        crumb.addEventListener("click", function (idx) {
            return function () { self.popToLevel(idx); };
        }(levelIdx));
        el.appendChild(crumb);
    }

    // Current position (terminal, non-clickable)
    var sepCur = this.document.createElement("span");
    sepCur.className = "rr-present-crumb-sep";
    sepCur.textContent = "›";
    el.appendChild(sepCur);
    var cur = this.document.createElement("span");
    cur.className = "rr-present-crumb rr-present-crumb-current";
    cur.textContent = this.deepTiddler
        ? this.labelForTiddler(this.deepTiddler)
        : this.labelForGridPos(this.section, this.slide);
    el.appendChild(cur);
};

PresentWidget.prototype.labelForGridPos = function (section, slide) {
    var sec = this.grid[section];
    if (!sec) { return "?"; }
    var t = sec.slides[slide];
    return this.labelForTiddler(t);
};

PresentWidget.prototype.labelForTiddler = function (title) {
    if (!title) { return "?"; }
    var tid = this.wiki.getTiddler(title);
    var caption = tid && tid.fields ? trim(tid.fields[this.captionField] || "") : "";
    if (caption) { return caption; }
    // Fall back to the leaf segment of the tiddler title.
    var idx = title.lastIndexOf("/");
    return idx >= 0 ? title.substring(idx + 1) : title;
};

PresentWidget.prototype.renderHud = function () {
    var el = this.hud;
    while (el.firstChild) { el.removeChild(el.firstChild); }
    if (this.deepTiddler) {
        var deep = this.document.createElement("div");
        deep.className = "rr-present-hud-deep";
        deep.textContent = "Deep-dive: " + this.labelForTiddler(this.deepTiddler);
        el.appendChild(deep);
        return;
    }
    var sec = this.grid[this.section];
    if (!sec) { return; }
    var counter = this.document.createElement("div");
    counter.className = "rr-present-hud-counter";
    counter.textContent = (this.section + 1) + "/" + this.grid.length +
        "  ·  " + (this.slide + 1) + "/" + sec.slides.length;
    el.appendChild(counter);

    var label = this.document.createElement("div");
    label.className = "rr-present-hud-label";
    label.textContent = this.labelForGridPos(this.section, this.slide);
    el.appendChild(label);
};

PresentWidget.prototype.renderNotes = function () {
    if (!this.notesPanel) { return; }
    var panel = this.notesPanel;
    while (panel.firstChild) { panel.removeChild(panel.firstChild); }
    var slideTitle = this.currentSlideTitle();
    var tid = slideTitle ? this.wiki.getTiddler(slideTitle) : null;
    var notes = tid && tid.fields ? trim(tid.fields[this.notesField] || "") : "";
    if (!notes) {
        var blank = this.document.createElement("em");
        blank.className = "rr-present-notes-empty";
        blank.textContent = "(no presenter notes)";
        panel.appendChild(blank);
    } else {
        var pre = this.document.createElement("pre");
        pre.className = "rr-present-notes-text";
        pre.textContent = notes;
        panel.appendChild(pre);
    }
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

PresentWidget.prototype.goSection = function (delta) {
    if (this.deepTiddler) { return; }  // arrows on deep view are no-op
    var next = this.section + delta;
    if (next < 0 || next > this.grid.length - 1) { return; }
    this.section = next;
    this.slide = 0;
    this.renderCurrent();
};

PresentWidget.prototype.goSlide = function (delta) {
    if (this.deepTiddler) { return; }
    var sec = this.grid[this.section];
    if (!sec) { return; }
    var next = this.slide + delta;
    if (next < 0 || next > sec.slides.length - 1) { return; }
    this.slide = next;
    this.renderCurrent();
};

// Linear "advance": go down within section, then jump to next section's top.
PresentWidget.prototype.advance = function () {
    if (this.deepTiddler) { return; }
    var sec = this.grid[this.section];
    if (!sec) { return; }
    if (this.slide < sec.slides.length - 1) {
        this.slide += 1;
        this.renderCurrent();
        return;
    }
    if (this.section < this.grid.length - 1) {
        this.section += 1;
        this.slide = 0;
        this.renderCurrent();
    }
};

PresentWidget.prototype.reverse = function () {
    if (this.deepTiddler) { return; }
    if (this.slide > 0) {
        this.slide -= 1;
        this.renderCurrent();
        return;
    }
    if (this.section > 0) {
        this.section -= 1;
        var sec = this.grid[this.section];
        this.slide = sec ? sec.slides.length - 1 : 0;
        this.renderCurrent();
    }
};

PresentWidget.prototype.goHome = function () {
    this.popToHome();
    this.section = 0;
    this.slide = 0;
    this.renderCurrent();
};

PresentWidget.prototype.goEnd = function () {
    this.popToHome();
    this.section = this.grid.length - 1;
    var sec = this.grid[this.section];
    this.slide = sec ? sec.slides.length - 1 : 0;
    this.renderCurrent();
};

// Deep-dive: push current location, replace with the supplied tiddler.
PresentWidget.prototype.diveInto = function (tiddler) {
    if (!tiddler) { return; }
    var current = this.deepTiddler
        ? { kind: "deep", tiddler: this.deepTiddler }
        : { kind: "grid", section: this.section, slide: this.slide };
    this.stack.push(current);
    this.deepTiddler = tiddler;
    this.renderCurrent();
};

// Pop exactly one stack frame.
PresentWidget.prototype.popOne = function () {
    if (!this.stack.length) { return false; }
    var prev = this.stack.pop();
    if (prev.kind === "grid") {
        this.deepTiddler = null;
        this.section = this.clampSection(prev.section);
        this.slide = this.clampSlide(this.section, prev.slide);
    } else {
        this.deepTiddler = prev.tiddler;
    }
    this.renderCurrent();
    return true;
};

PresentWidget.prototype.popToHome = function () {
    if (!this.stack.length && !this.deepTiddler) { return; }
    // Find the bottom-most grid entry; if none, just clear.
    var first = this.stack.length ? this.stack[0] : null;
    this.stack = [];
    if (first && first.kind === "grid") {
        this.deepTiddler = null;
        this.section = this.clampSection(first.section);
        this.slide = this.clampSlide(this.section, first.slide);
    } else {
        this.deepTiddler = null;
    }
    this.renderCurrent();
};

PresentWidget.prototype.popToLevel = function (level) {
    // level is the index into this.stack we want to re-enter.
    if (level < 0 || level >= this.stack.length) { return; }
    var entry = this.stack[level];
    // Drop everything from `level` onwards.
    this.stack = this.stack.slice(0, level);
    if (entry.kind === "grid") {
        this.deepTiddler = null;
        this.section = this.clampSection(entry.section);
        this.slide = this.clampSlide(this.section, entry.slide);
    } else {
        this.deepTiddler = entry.tiddler;
    }
    this.renderCurrent();
};

// ---------------------------------------------------------------------------
// Close + on-close-actions
// ---------------------------------------------------------------------------

// If on-close-actions are supplied, they drive teardown via state-tiddler
// changes (the parent $reveal sees the state clear, refreshes, calls our
// removeChildDomNodes). Calling teardown() here too would lead to a double
// detach. Without on-close-actions, fall back to manual DOM removal.
PresentWidget.prototype.close = function () {
    if (this.onCloseActions) {
        try { this.invokeActionString(this.onCloseActions, this, null, {}); }
        catch (e) { this.teardown(); }
        return;
    }
    this.teardown();
};

PresentWidget.prototype.teardown = function () {
    if (this.unbindKeydown) { this.unbindKeydown(); this.unbindKeydown = null; }
    if (this.rootDom && this.rootDom.parentNode) {
        this.rootDom.parentNode.removeChild(this.rootDom);
    }
};

// ---------------------------------------------------------------------------
// Keyboard + click handlers
// ---------------------------------------------------------------------------

PresentWidget.prototype.bindEvents = function () {
    var self = this;
    var handler = function (ev) {
        // Ignore keys while focus is in an input/textarea inside the overlay
        // (so editable layouts don't lose typed characters).
        var t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            return;
        }
        // We only intercept keys when the overlay is actually attached.
        if (!self.rootDom || !self.rootDom.parentNode) { return; }
        var k = ev.key;
        switch (k) {
            case "ArrowRight": self.goSection(+1); ev.preventDefault(); break;
            case "ArrowLeft":  self.goSection(-1); ev.preventDefault(); break;
            case "ArrowDown":  self.goSlide(+1);   ev.preventDefault(); break;
            case "ArrowUp":    self.goSlide(-1);   ev.preventDefault(); break;
            case " ":          self.advance();     ev.preventDefault(); break;
            case "Backspace":  self.reverse();     ev.preventDefault(); break;
            case "Home":       self.goHome();      ev.preventDefault(); break;
            case "End":        self.goEnd();       ev.preventDefault(); break;
            case "n": case "N": self.toggleNotes(); ev.preventDefault(); break;
            case "?": case "/": self.toggleHelp();  ev.preventDefault(); break;
            case "Escape":
                if (self.escDisabled()) { return; }
                if (self.helpOpen) { self.toggleHelp(); ev.preventDefault(); break; }
                if (self.notesOpen) { self.toggleNotes(); ev.preventDefault(); break; }
                if (self.stack.length || self.deepTiddler) { self.popOne(); ev.preventDefault(); break; }
                self.close(); ev.preventDefault(); break;
        }
    };
    this.document.addEventListener("keydown", handler, true);
    this.unbindKeydown = function () {
        self.document.removeEventListener("keydown", handler, true);
    };
};

PresentWidget.prototype.escDisabled = function () {
    var tid = this.wiki.getTiddler(ESC_CONFIG);
    return !!(tid && trim(tid.fields.text || "").toLowerCase() === "yes");
};

// Intercept clicks on links inside slide content. Determine the target
// tiddler title from the anchor's data-tiddler-title attribute (set by
// TW's <$link>), fall back to href= parsing for plain anchors.
PresentWidget.prototype.handleStageClick = function (ev) {
    var t = ev.target;
    // Walk up to find an anchor or a tc-tiddlylink element.
    var anchor = null;
    while (t && t !== this.stage) {
        if (t.nodeType === 1) {
            var tag = (t.tagName || "").toLowerCase();
            if (tag === "a" || (t.classList && t.classList.contains("tc-tiddlylink"))) {
                anchor = t;
                break;
            }
        }
        t = t.parentNode;
    }
    if (!anchor) { return; }
    var title = anchor.getAttribute("data-tiddler-title") ||
                anchor.getAttribute("data-tw-target-title") ||
                anchor.getAttribute("href") || "";
    title = title.replace(/^#/, "");
    if (!title) { return; }
    if (!this.wiki.getTiddler(title)) {
        // Allow shadow tiddlers via tiddlerExists.
        if (!(this.wiki.tiddlerExists && this.wiki.tiddlerExists(title))) { return; }
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.diveInto(title);
};

// ---------------------------------------------------------------------------
// Notes / help toggles
// ---------------------------------------------------------------------------

PresentWidget.prototype.toggleNotes = function () {
    this.notesOpen = !this.notesOpen;
    this.notesPanel.style.display = this.notesOpen ? "" : "none";
    if (this.notesBtn) {
        if (this.notesOpen) { this.notesBtn.classList.add("rr-present-btn-active"); }
        else { this.notesBtn.classList.remove("rr-present-btn-active"); }
    }
    this.renderNotes();
};

PresentWidget.prototype.toggleHelp = function () {
    this.helpOpen = !this.helpOpen;
    this.helpPanel.style.display = this.helpOpen ? "" : "none";
};

// ---------------------------------------------------------------------------
// Cleanup on widget destruction
// ---------------------------------------------------------------------------

PresentWidget.prototype.removeChildDomNodes = function () {
    if (this.unbindKeydown) { this.unbindKeydown(); this.unbindKeydown = null; }
    Widget.prototype.removeChildDomNodes.call(this);
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

exports.present = PresentWidget;
// Internal helpers exposed for unit tests.
exports._buildGrid = buildGrid;
