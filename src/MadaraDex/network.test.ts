import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTH_REFRESH_URL,
  buildCatalogUrl,
  buildChapterAjaxRequests,
  buildMangaUrl,
  buildRefreshRequest,
  parseMangaUrl,
} from "./network.js";

describe("MadaraDex routes", () => {
  it("preserves archived numeric manga IDs and resolves pasted URLs", () => {
    assert.equal(buildMangaUrl("2872"), "https://madaradex.org/?p=2872");
    assert.equal(parseMangaUrl("https://madaradex.org/?p=2872"), "2872");
    assert.equal(parseMangaUrl("https://madaradex.org/title/savage-hero/"), undefined);
    assert.throws(() => buildMangaUrl("savage-hero"), /numeric/i);
  });

  it("builds deterministic listing and complete advanced-search URLs", () => {
    assert.equal(
      buildCatalogUrl({ title: "" }, { id: "latest", label: "Latest" }, 2),
      "https://madaradex.org/title/page/2/?m_orderby=latest",
    );

    const url = new URL(
      buildCatalogUrl(
        {
          title: "  magic   hero  ",
          metadata: {
            genres: ["martial-arts", "action"],
            genreCondition: "and",
            author: "Yönoki",
            artist: "Studio A",
            release: "2026",
            adult: "none",
            status: ["end", "on-going"],
          },
        },
        { id: "rating", label: "Rating" },
        3,
      ),
    );
    assert.equal(url.pathname, "/page/3/");
    assert.equal(url.searchParams.get("s"), "magic hero");
    assert.equal(url.searchParams.get("post_type"), "wp-manga");
    assert.deepEqual(url.searchParams.getAll("genre[]"), ["action", "martial-arts"]);
    assert.equal(url.searchParams.get("op"), "1");
    assert.equal(url.searchParams.get("author"), "Yönoki");
    assert.equal(url.searchParams.get("artist"), "Studio A");
    assert.equal(url.searchParams.get("release"), "2026");
    assert.equal(url.searchParams.get("adult"), "0");
    assert.deepEqual(url.searchParams.getAll("status[]"), ["end", "on-going"]);
    assert.equal(url.searchParams.get("m_orderby"), "rating");
  });

  it("builds both known Madara chapter endpoints and the internal auth refresh", () => {
    const requests = buildChapterAjaxRequests("2872");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://madaradex.org/wp-admin/admin-ajax.php");
    assert.equal(typeof requests[0]?.body, "string");
    assert.equal(typeof requests[1]?.body, "string");
    assert.match(requests[0]?.body as string, /action=manga_get_chapters&manga=2872/);
    assert.match(requests[1]?.body as string, /action=ajax_chap/);

    const auth = buildRefreshRequest();
    assert.equal(auth.url, AUTH_REFRESH_URL);
    assert.equal(auth.method, "POST");
    assert.equal(auth.headers?.["x-mdx-auth-refresh"], "1");
    assert.equal(auth.body, "action=mdx_auth_refresh");
  });
});
