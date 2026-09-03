const catalogEntry = (
  id: number,
  slug: string,
  title: string,
  genreId: number,
  genreSlug: string,
  genreName: string,
) => ({
  id,
  slug,
  status: "publish",
  type: "comic",
  link: `https://rinkocomics.com/comic/${slug}/`,
  title: { rendered: title },
  featured_media: id + 1,
  comics_genres: [genreId],
  _embedded: {
    "wp:featuredmedia": [
      {
        id: id + 1,
        media_type: "image",
        mime_type: "image/webp",
        source_url: `https://rinkocomics.com/wp-content/uploads/2026/01/${slug}.webp`,
      },
    ],
    "wp:term": [[{ id: genreId, slug: genreSlug, name: genreName, taxonomy: "comics_genres" }]],
  },
});

export const REST_CATALOG = [
  catalogEntry(900, "fixture-flower-path", "Fixture Flower Path", 6, "action", "Action"),
  catalogEntry(800, "another-series", "Another Series", 13, "romance", "Romance"),
];

export const REST_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "x-wp-total": "2",
  "x-wp-totalpages": "1",
};

export const GENRE_RESPONSE = [
  {
    id: 6,
    count: 8,
    name: "Action",
    slug: "action",
    taxonomy: "comics_genres",
    link: "https://rinkocomics.com/comics_genres/action/",
  },
  {
    id: 13,
    count: 315,
    name: "Romance",
    slug: "romance",
    taxonomy: "comics_genres",
    link: "https://rinkocomics.com/comics_genres/romance/",
  },
];

export const ARCHIVE_HTML = `
  <div class="ac-grid">
    <article class="ac-card" data-id="900">
      <a class="ac-thumb" href="https://rinkocomics.com/comic/fixture-flower-path/">
        <img src="https://rinkocomics.com/wp-content/uploads/2026/01/fixture-flower-path.webp">
      </a>
      <div class="ac-card-body">
        <h2 class="ac-title"><a href="https://rinkocomics.com/comic/fixture-flower-path/">Fixture Flower Path</a></h2>
        <div class="ac-genres"><a href="https://rinkocomics.com/comics_genres/action/">Action</a></div>
      </div>
    </article>
  </div>
`;

const chapterRow = (number: number, reason: "free" | "login_required"): string => {
  const slug = `fixture-flower-path-chapter-${number}`;
  const url = `https://rinkocomics.com/chapter/${slug}/`;
  return `
    <li class="chapter ${reason === "free" ? "" : "is-locked"}"
        data-post-id="${1_000 + number}"
        data-price="100"
        data-title="Fixture Flower Path Chapter ${number}"
        data-reason="${reason}"
        data-permalink="${url}">
      <a href="${reason === "free" ? url : "#"}">
        <div class="chapter-details">
          <span class="chapter-number">Chapter ${number}</span>
          <span class="chapter-date">Jan ${number}, 2026</span>
        </div>
      </a>
    </li>`;
};

const initialRows = Array.from({ length: 10 }, (_, index) => 12 - index)
  .map((number) => chapterRow(number, number === 5 ? "login_required" : "free"))
  .join("");

export const SERIES_HTML = `
  <html><head>
    <link rel="canonical" href="https://rinkocomics.com/comic/fixture-flower-path/">
  </head><body>
    <div class="comic-page-content">
      <div class="comic-cover"><img class="comic-cover__image" src="https://rinkocomics.com/wp-content/uploads/2026/01/fixture-flower-path.webp"></div>
      <div class="comic-info-upper">
        <h1>Fixture Flower Path</h1>
        <div class="comic-graph"><span>Fixture Author</span><span> • </span><span>Manhwa</span><span> • </span><span>1.2K</span></div>
      </div>
      <div class="statistics">
        <div><div><span>Status</span><span>ongoing</span></div></div>
        <div><div><span>Chapters</span><span>12</span></div></div>
        <div><div><span>Updated</span><span>January 12, 2026</span></div></div>
      </div>
      <div class="comic-genres"><div class="genres"><span class="genre">Action</span><span class="genre">Romance</span></div></div>
      <div class="alt-titles-list"><span class="alt-title">Fixture Alt / 꽃길</span></div>
      <div class="comic-synopsis"><p>A safe &amp; deterministic synopsis.</p><script>steal()</script></div>
      <div class="comic-page-chapters">
        <div><div>Chapters (12)</div><button class="reverse-order-btn">Newest First</button></div>
        <ul class="chapters-list">${initialRows}</ul>
        <div class="load-more-container">
          <button class="load-more-btn" id="loadMoreChaptersBtn" data-comic-id="900" data-offset="10"></button>
          <div id="loadingSpinner"></div>
        </div>
      </div>
    </div>
    <script>var comicworld_ajax = {"ajax_url":"https://rinkocomics.com/wp-admin/admin-ajax.php","nonce":"abc123DEF456"};</script>
  </body></html>
`;

export const SHORT_SERIES_HTML = SERIES_HTML.replace("<span>12</span>", "<span>8</span>")
  .replace("Chapters (12)", "Chapters (8)")
  .replace(
    initialRows,
    Array.from({ length: 8 }, (_, index) => chapterRow(8 - index, "free")).join(""),
  );

export const AJAX_ROWS = {
  success: true,
  data: {
    html: `${chapterRow(2, "login_required")}${chapterRow(1, "free")}`,
  },
};

export const EMPTY_AJAX_ROWS = { success: true, data: { html: "" } };

export const READER_HTML = `
  <html><head>
    <link rel="canonical" href="https://rinkocomics.com/chapter/fixture-flower-path-chapter-12/">
    <link rel="alternate" type="application/json" href="https://rinkocomics.com/wp-json/wp/v2/chapters/1012">
  </head><body>
    <h1 class="chapter-title">Fixture Flower Path Chapter 12 <span class="chapter-tag free">Free</span></h1>
    <span class="status-message">Ready to read</span>
    <span class="pages-count">2 pages</span>
    <div class="chapter-images-section"><div class="chapter-images-outer"><div class="images-flow">
      <img class="chapter-image lazy-image" data-page="1" data-src="https://cdn.rinkocomics.com/wp-content/uploads/comics/fixture-flower-path/12/01.webp">
      <img class="chapter-image lazy-image" data-page="2" data-src="https://cdn.rinkocomics.com/wp-content/uploads/comics/fixture-flower-path/12/02.webp">
    </div></div></div>
  </body></html>
`;
