export const BROWSE_FILTER_HTML = `
  <form id="browse-filter-form">
    <select id="bf-status" name="status">
      <option value="">Any</option><option value="ongoing">Ongoing</option>
      <option value="completed">Completed</option><option value="hiatus">Hiatus</option>
    </select>
    <select id="bf-type" name="type">
      <option value="">Any</option><option value="manga">Manga</option>
      <option value="manhwa">Manhwa</option><option value="manhua">Manhua</option>
      <option value="webtoon">Webtoon</option>
    </select>
    <button class="chip" data-group="include_genres" data-value="Martial arts">Martial Arts</button>
    <button class="chip" data-group="include_genres" data-value="Action">Action</button>
    <button class="chip" data-group="include_genres" data-value="Mature">Mature</button>
  </form>
`;

export const BROWSE_RESULTS_HTML = `
  <article class="comic-card">
    <div class="comic-card__cover">
      <span class="comic-card__badge">Trending</span>
      <a href="/manga/dark-~-mage/"><img src="/placeholder.gif" data-src="https://imgsrv5.com/cover%20one.webp" alt="Dark ~ Mage"></a>
    </div>
    <h3 class="comic-card__title"><a href="/manga/dark-~-mage/">Dark ~ Ma…</a></h3>
    <div class="comic-card__stats">
      <span class="comic-card__stat--hot"><span class="stat-weekly">12,345</span></span>
      <span class="comic-card__stat--rating">⭐ 4.5</span>
    </div>
  </article>
  <article class="comic-card">
    <a href="/manga/dark-~-mage/"><img src="https://imgsrv5.com/duplicate.webp" alt="Duplicate"></a>
    <h3 class="comic-card__title">Duplicate</h3>
  </article>
  <article class="comic-card">
    <a href="/manga/safe-series/"><img src="javascript:alert(1)" alt="Safe Series"></a>
    <h3 class="comic-card__title">Safe Series</h3>
  </article>
`;

export const SERIES_HTML = `
  <html><head>
    <link rel="canonical" href="https://www.mgeko.cc/manga/dark-~-mage/">
  </head><body>
    <div class="fixed-img"><img src="/placeholder.png" data-src="https://imgsrv5.com/dark.webp" alt="Dark ~ Mage"></div>
    <div class="main-head">
      <h1 class="novel-title">Dark ~ Mage</h1>
      <h2 class="alternative-title">Dark Mage, Updating, 暗黒の魔導士</h2>
      <div class="author"><span>Author:</span><a><span itemprop="author">A. Writer</span></a></div>
      <div class="rating-star"><strong>4.5 (120)</strong></div>
    </div>
    <div class="header-stats">
      <span><strong>21-1-eng-li</strong><small>Chapters</small></span>
      <span><strong>1.2 M</strong><small>Views</small></span>
      <span><strong>240</strong><small>Bookmarked</small></span>
      <span><strong class="ongoing">Ongoing</strong><small>Status</small></span>
    </div>
    <div class="categories"><ul><li>Action</li><li>Mature</li></ul></div>
    <p class="description">
      Dark ~ Mage is available in English. The Summary is<br><br>
      <strong>A careful synopsis &amp; more.</strong><script>steal()</script>
    </p>
  </body></html>
`;

export const CHAPTERS_HTML = `
  <ul class="chapter-list">
    <li><a href="/reader/en/dark-~-mage-chapter-21-1-eng-li/">
      <strong class="chapter-title">21-1-eng-li</strong>
      <time class="chapter-update" datetime="Aug. 6, 2026, 2:21 p.m."></time>
    </a></li>
    <li><a href="/reader/en/dark-~-mage-chapter-2-eng-li/">
      <strong class="chapter-title">2-eng-li</strong>
      <time class="chapter-update" datetime="July 30, 2026, 2:04 p.m."></time>
    </a></li>
    <li><a href="/reader/en/dark-~-mage-prologue-eng-li/">
      <strong class="chapter-title">Prologue</strong>
      <time class="chapter-update" datetime="not a date"></time>
    </a></li>
  </ul>
`;

export const READER_HTML = `
  <section class="page-in">
    <img src="/placeholder.gif" data-src="https://imgsrv5.com/pages/01.jpg">
    <img src="https://imgsrv5.com/pages/02.jpg">
    <img src="https://imgsrv5.com/pages/02.jpg">
    <img src="https://imgsrv5.com/credits-mgeko.png">
    <img src="http://imgsrv5.com/insecure.jpg">
    <img src="javascript:alert(1)">
  </section>
`;
