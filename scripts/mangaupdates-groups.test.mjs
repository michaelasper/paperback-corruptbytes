import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseGroupDetailLinks,
  parseGroupsList,
  summarizeContactDomains,
} from "./mangaupdates-groups.mjs";

const LIST_HTML = `<div>
<div class="col-12 row g-0 group-list-module__Bk_oea__alt">
<div class="col-sm-5 col-9 text"><a title="Click for Group Info" href="https://www.mangaupdates.com/group/yll7j71/netascans"><span>!Netascans</span></a></div>
<div class="col-sm-2 col-3 text text-end text-sm-center">No</div>
<div class="col-sm-5 d-none d-sm-block text"><span><a rel="nofollow" target="_blank" title="Site" href="https://mangadex.org/group/17462/netascans">Site</a></span></div>
</div>
<div class="col-12 row g-0 group-list-module__Bk_oea__alt">
<div class="col-sm-5 col-9 text"><a title="Click for Group Info" href="https://www.mangaupdates.com/group/3aw0piq/hanging-on-scan"><span>Hanging On Scan</span></a></div>
<div class="col-sm-2 col-3 text text-end text-sm-center">Yes</div>
<div class="col-sm-5 d-none d-sm-block text"><span><a rel="nofollow" target="_blank" title="Site" href="https://example-scans.example.com/">Site</a></span></div>
</div>
</div>`;

void test("mangaupdates groups list keeps stable IDs, active flags, and contact domains", () => {
  const groups = parseGroupsList(LIST_HTML, "H");
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.id, "yll7j71");
  assert.equal(groups[0]?.active, false);
  assert.equal(groups[0]?.contactDomain, "mangadex.org");
  assert.equal(groups[1]?.active, true);
  assert.equal(
    groups[1]?.mangaUpdatesUrl,
    "https://www.mangaupdates.com/group/3aw0piq/hanging-on-scan",
  );
});

void test("mangaupdates domain summary ranks scan sites for support decisions", () => {
  const groups = parseGroupsList(LIST_HTML, "H");
  const summary = summarizeContactDomains(groups);
  assert.equal(summary.length, 2);
  assert.ok(summary.every((entry) => entry.count === 1));
});

void test("mangaupdates group detail keeps external site links and drops internal links", () => {
  const links = parseGroupDetailLinks(
    `<div><a href="https://example-scans.example.com/">Site</a>` +
      `<a href="https://www.mangaupdates.com/group/yll7j71/netascans">Self</a></div>`,
  );
  assert.deepEqual(links, ["https://example-scans.example.com/"]);
});
