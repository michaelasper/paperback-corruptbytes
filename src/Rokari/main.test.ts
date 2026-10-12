import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Request, Response, SortingOption } from "@paperback/types";

import { RokariExtension } from "./main.js";
import { ROKARI_CATALOG_HTML, ROKARI_SERIES_HTML } from "./test-fixtures.js";

const originalApplication = globalThis.Application;
let requests: string[];

beforeEach(() => {
  requests = [];
  Object.assign(globalThis, {
    Application: {
      arrayBufferToUTF8String: (data: ArrayBuffer) => new TextDecoder().decode(data),
      scheduleRequest: async (request: Request): Promise<[Response, ArrayBuffer]> => {
        requests.push(request.url);
        const html = request.url.includes("/manga/bunker-days/")
          ? ROKARI_SERIES_HTML
          : ROKARI_CATALOG_HTML.replaceAll(
              "Bunker Days",
              request.url.endsWith("order=popular") ? "Popular Bunker Days" : "Bunker Days",
            );
        return [
          { url: request.url, status: 200, headers: {}, cookies: [] },
          new TextEncoder().encode(html).buffer,
        ];
      },
    },
  });
});

afterEach(() => Object.assign(globalThis, { Application: originalApplication }));

const popular = { id: "popular", label: "Popular" } satisfies SortingOption;

describe("Rokari search entrypoint", () => {
  it("honors the advertised Popular sort for a blank unfiltered catalog", async () => {
    const extension = new RokariExtension();
    const option = (await extension.getSortingOptions({ title: "" })).find(
      (item) => item.id === "popular",
    );
    assert.ok(option);
    const result = await extension.getSearchResults({ title: "  " }, undefined, option);
    assert.equal(result.items[0]?.title, "Popular Bunker Days");
    assert.equal(result.items[0]?.mangaId, "bunker-days");
    assert.deepEqual(requests, ["https://rokaricomics.com/manga/?order=popular"]);
  });

  for (const option of [
    undefined,
    { id: "update", label: "Updated" },
    { id: "other", label: "Other" },
  ]) {
    it(`uses recently updated for ${option?.id ?? "default"} sorting`, async () => {
      const result = await new RokariExtension().getSearchResults({ title: "" }, undefined, option);
      assert.equal(result.items[0]?.title, "Bunker Days");
      assert.deepEqual(requests, ["https://rokaricomics.com/manga/?order=update"]);
    });
  }

  it("preserves genre and keyword precedence without adding sort parameters", async () => {
    const extension = new RokariExtension();
    const genre = await extension.getSearchResults(
      { title: " ", metadata: { genres: ["action", "drama"] } },
      undefined,
      popular,
    );
    assert.equal(genre.items[0]?.mangaId, "bunker-days");
    const keyword = await extension.getSearchResults(
      { title: " Bunker ", metadata: { genres: ["action"] } },
      undefined,
      popular,
    );
    assert.equal(keyword.items[0]?.mangaId, "bunker-days");
    assert.deepEqual(requests, [
      "https://rokaricomics.com/genres/action/",
      "https://rokaricomics.com/?s=Bunker",
    ]);
  });

  it("terminates later catalog pages but resolves pasted URLs before pagination and filters", async () => {
    const extension = new RokariExtension();
    assert.deepEqual(await extension.getSearchResults({ title: "" }, { page: 2 }, popular), {
      items: [],
    });
    assert.deepEqual(
      await extension.getSearchResults(
        { title: "Bunker", metadata: { genres: ["action"] } },
        { page: 2 },
        popular,
      ),
      { items: [] },
    );
    assert.deepEqual(requests, []);
    const pasted = await extension.getSearchResults(
      { title: "https://rokaricomics.com/manga/bunker-days/", metadata: { genres: ["action"] } },
      { page: 2 },
      popular,
    );
    assert.equal(pasted.items[0]?.title, "Bunker Days");
    assert.equal(pasted.items[0]?.mangaId, "bunker-days");
    assert.deepEqual(requests, ["https://rokaricomics.com/manga/bunker-days/"]);
  });
});
