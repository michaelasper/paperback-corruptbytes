export const FILTERS_HTML = `
  <form class="search-advanced-form">
    <input id="action" value="action" name="genre[]" type="checkbox"><label for="action"> Action </label>
    <input id="martial-arts" value="martial-arts" name="genre[]" type="checkbox"><label for="martial-arts"> Martial Arts </label>
    <input id="mature" value="mature" name="genre[]" type="checkbox"><label for="mature"> Mature </label>
    <input id="on-going" value="on-going" name="status[]" type="checkbox"><label for="on-going">Ongoing</label>
    <input id="end" value="end" name="status[]" type="checkbox"><label for="end">Completed</label>
  </form>
`;

export const DIRECTORY_HTML = `
  <div id="loop-content">
    <div class="page-listing-item">
      <div class="page-item-detail manga">
        <div id="manga-item-574" class="item-thumb" data-post-id="574">
          <a href="https://madaradex.org/title/magic-emperor/" title="Magic Emperor">
            <img src="/placeholder.jpg" data-src="https://madaradex.org/wp-content/uploads/574.webp" alt="574">
          </a>
        </div>
        <div class="item-summary">
          <div class="post-title"><h3><a href="/title/magic-emperor/">Magic Emperor</a></h3></div>
          <div class="post-total-rating"><span class="score">4</span></div>
          <div class="post-content_item mg_genres"><div class="summary-content">
            <a href="/genre/action/">Action</a>, <a href="/genre/fantasy/">Fantasy</a>
          </div></div>
          <div class="list-chapter"><div class="chapter-item"><span class="chapter">
            <a href="/title/magic-emperor/chapter-894/">Chapter 894</a>
          </span></div></div>
        </div>
      </div>
    </div>
    <div class="page-listing-item">
      <div class="page-item-detail manga">
        <div id="manga-item-622" class="item-thumb" data-post-id="622">
          <a href="/title/adult-series/"><img src="/placeholder.jpg" data-src="/wp-content/uploads/622.webp" alt="622">
            <span class="manga-title-badges adult"><span class="text">18+</span></span>
          </a>
        </div>
        <div class="item-summary"><div class="post-title"><h3><a href="/title/adult-series/">Adult Series</a></h3></div></div>
      </div>
    </div>
    <div class="page-listing-item">
      <div class="page-item-detail manga"><div id="manga-item-574" class="item-thumb"></div></div>
    </div>
  </div>
  <a class="nextpostslink" rel="next" href="/title/page/2/?m_orderby=latest">Next</a>
`;

export const SEARCH_HTML = `
  <div class="c-tabs-item__content">
    <div class="tab-thumb"><a href="/title/magical-girl-wife/">
      <img src="/placeholder.jpg" data-src="/wp-content/uploads/2947.webp" alt="2947">
    </a></div>
    <div class="tab-summary">
      <div class="post-title"><h3><a href="/title/magical-girl-wife/">Magical Girl Wife</a></h3></div>
      <div class="post-content_item mg_genres"><div class="summary-content"><a>Mature</a></div></div>
    </div>
    <div class="tab-meta"><div class="latest-chap"><span class="chapter">
      <a href="/title/magical-girl-wife/chapter-20/">Chapter 20</a>
    </span></div></div>
  </div>
`;

export const SERIES_HTML = `
  <html><head>
    <link rel="canonical" href="https://madaradex.org/title/savage-hero/">
    <link rel="shortlink" href="https://madaradex.org/?p=2872">
  </head><body>
    <div class="post-title"><span class="manga-title-badges adult">18+</span><h1>Savage Hero</h1></div>
    <div class="tab-summary">
      <div class="summary_image"><img src="/placeholder.jpg" data-src="/wp-content/uploads/2872.webp" alt="2872"></div>
      <div class="post-rating"><span id="averagerate">4</span></div>
      <div class="post-content_item"><div class="summary-heading"><h5>Alternative</h5></div>
        <div class="summary-content">Incubus of Frustration, 鬼畜英雄</div></div>
      <div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div>
        <div class="summary-content"><div class="author-content"><a>Yonoki</a></div></div></div>
      <div class="post-content_item"><div class="summary-heading"><h5>Artist(s)</h5></div>
        <div class="summary-content"><div class="artist-content"><a>Yonoki</a></div></div></div>
      <div class="post-content_item"><div class="summary-heading"><h5>Genre(s)</h5></div>
        <div class="summary-content"><div class="genres-content"><a>Action</a><a>Mature</a></div></div></div>
      <div class="post-status"><div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div>
        <div class="summary-content">Ongoing</div></div></div>
    </div>
    <div class="description-summary"><div class="summary__content"><p>A brutal &amp; funny story.</p><script>steal()</script></div></div>
    <ul class="main version-chap">
      <li class="wp-manga-chapter"><a href="/title/savage-hero/chapter-2/">Chapter 2</a>
        <span class="chapter-release-date"><i>June 25, 2026</i></span></li>
      <li class="wp-manga-chapter"><a href="/title/savage-hero/chapter-1-1/">Chapter 1.1 — Extra</a>
        <span class="chapter-release-date"><i>not a date</i></span></li>
      <li class="wp-manga-chapter"><a href="/title/savage-hero/chapter-0/">Prologue</a>
        <span class="chapter-release-date"><i>Mar 13, 2026</i></span></li>
    </ul>
  </body></html>
`;

export const READER_HTML = `
  <div class="reading-content">
    <div class="page-break"><img data-src=" https://cdn.madaradex.org/manga_abc/chapter-2/1.webp "></div>
    <div class="page-break"><img src="https://cdn.madaradex.org/manga_abc/chapter-2/2.webp"></div>
    <div class="page-break"><img data-src="https://cdn.madaradex.org/manga_abc/chapter-2/2.webp"></div>
    <div class="page-break"><img src="/wp-content/themes/madara/images/dflazy.jpg"></div>
    <div class="page-break"><img data-src="javascript:alert(1)"></div>
  </div>
`;

export const NOVEL_READER_HTML = `
  <div class="reading-content"><div class="text-left">
    <h1>Chapter 3</h1><p>Hello &amp; goodbye.</p><script>steal()</script>
  </div></div>
`;
