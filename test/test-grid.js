/*\
title: $:/plugins/rimir/present/test/test-grid.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Unit tests for the 2D grid builder behind `<$present>`. The widget's nav
logic depends entirely on the grid shape, so pin it down here.

\*/

"use strict";

describe("present-grid", function () {
    var widget = require("$:/plugins/rimir/present/widget.js");
    var buildGrid = widget._buildGrid;

    // Tiny stand-in for $tw.Wiki — buildGrid only calls .getTiddler.
    function fakeWiki(map) {
        return {
            getTiddler: function (t) {
                return map[t] ? { fields: map[t] } : null;
            }
        };
    }

    it("groups consecutive slides with the same section-field value", function () {
        var wiki = fakeWiki({
            "n1/slides/a": { "mm.slide-of": "n1" },
            "n1/slides/b": { "mm.slide-of": "n1" },
            "n2/slides/c": { "mm.slide-of": "n2" }
        });
        var grid = buildGrid(
            ["n1/slides/a", "n1/slides/b", "n2/slides/c"],
            wiki,
            "mm.slide-of"
        );
        expect(grid.length).toBe(2);
        expect(grid[0].key).toBe("n1");
        expect(grid[0].slides).toEqual(["n1/slides/a", "n1/slides/b"]);
        expect(grid[1].key).toBe("n2");
        expect(grid[1].slides).toEqual(["n2/slides/c"]);
    });

    it("preserves input order across sections", function () {
        var wiki = fakeWiki({
            "a": { "mm.slide-of": "S1" },
            "b": { "mm.slide-of": "S2" },
            "c": { "mm.slide-of": "S1" },
            "d": { "mm.slide-of": "S2" }
        });
        // Note: non-contiguous same-section entries get separate buckets only
        // when the section-field changes BETWEEN them — buildGrid in fact
        // re-uses an earlier bucket when the same key reappears. That's the
        // intended behaviour: "section" means "group", not "contiguous run".
        var grid = buildGrid(["a", "b", "c", "d"], wiki, "mm.slide-of");
        expect(grid.length).toBe(2);
        expect(grid[0].slides).toEqual(["a", "c"]);
        expect(grid[1].slides).toEqual(["b", "d"]);
    });

    it("buckets each slide-without-section-field into its own solo group", function () {
        // Two slides with no section field should NOT collapse into one group
        // — that would look like a multi-slide stack to the user when they're
        // actually unrelated tiddlers.
        var wiki = fakeWiki({
            "a": {},
            "b": {}
        });
        var grid = buildGrid(["a", "b"], wiki, "mm.slide-of");
        expect(grid.length).toBe(2);
        expect(grid[0].slides).toEqual(["a"]);
        expect(grid[1].slides).toEqual(["b"]);
    });

    it("handles missing tiddlers gracefully", function () {
        var wiki = fakeWiki({}); // returns null for everything
        var grid = buildGrid(["nope"], wiki, "mm.slide-of");
        // Falls into the solo bucket since no fields available.
        expect(grid.length).toBe(1);
        expect(grid[0].slides).toEqual(["nope"]);
    });

    it("treats whitespace-only section values as missing", function () {
        var wiki = fakeWiki({
            "a": { "mm.slide-of": "  " },
            "b": { "mm.slide-of": "  " }
        });
        var grid = buildGrid(["a", "b"], wiki, "mm.slide-of");
        expect(grid.length).toBe(2);
    });

    it("returns an empty grid for an empty title list", function () {
        var wiki = fakeWiki({});
        expect(buildGrid([], wiki, "mm.slide-of")).toEqual([]);
    });

    it("honours a custom section-field name", function () {
        var wiki = fakeWiki({
            "a": { "myField": "X" },
            "b": { "myField": "X" }
        });
        var grid = buildGrid(["a", "b"], wiki, "myField");
        expect(grid.length).toBe(1);
        expect(grid[0].slides).toEqual(["a", "b"]);
    });
});
