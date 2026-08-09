export const DIRECTORY_HTML = `<!doctype html>
<html><body>
  <form class="filters">
    <input id="genre-10" name="genre[]" value="10" type="checkbox"><label for="genre-10">Action</label>
    <input id="genre-20" name="genre[]" value="20" type="checkbox"><label for="genre-20">Adult</label>
  </form>
  <div class="listupd">
    <div class="bs"><div class="bsx">
      <a href="/comics/storm-architect/" title="Storm Architect">
        <div class="limit"><img data-src="/covers/storm architect.webp" alt="Storm Architect"></div>
        <div class="bigor">
          <div class="tt">Storm Architect</div><div class="numscore">9.2</div>
          <div class="status"><i>Ongoing</i></div>
        </div>
      </a>
    </div></div>
    <div class="bs"><div class="bsx">
      <a href="https://en-thunderscans.com/comics/night-circuit/" title="Night Circuit">
        <div class="limit"><img src="https://img.example/night.jpg"></div>
        <div class="tt">Night Circuit</div><div class="numscore">8.0</div>
        <div class="status"><i>Completed</i></div>
      </a>
    </div></div>
  </div>
  <div class="pagination"><a class="next page-numbers" href="/comics/?page=2">Next</a></div>
</body></html>`;

export const HOME_HTML = `<!doctype html>
<html><body>
  <div class="hotslid"><div class="bixbox hothome full">
    <div class="releases"><h2>Popular Today</h2></div>
    <div class="pop-list"><div class="bsx">
      <a href="/comics/popular-storm/" title="Popular Storm"><img src="/covers/popular.jpg">
      <div class="tt">Popular Storm</div><div class="numscore">9.5</div><div class="status"><i>Ongoing</i></div></a>
    </div></div>
  </div></div>
  <div class="postbody">
    <div class="bixbox"><div class="releases"><h2>Editor's Pick</h2></div><div class="pop-list">
      <div class="bsx"><a href="/comics/editors-orbit/" title="Editor’s Orbit"><img src="/covers/editor.jpg"></a>
      <div class="tt">Editor’s Orbit</div><div class="adds"><div class="epxs">Chapter 12.5</div><div class="epxdate">2 days ago</div></div></div>
    </div></div>
    <div class="bixbox"><div class="releases"><h2>Latest Comics</h2></div>
      <div class="latest-updates" id="manga-posts"><div class="bsx">
        <a href="/comics/latest-bolt/" title="Latest Bolt"><img src="/covers/latest.jpg"></a>
        <div class="tt">Latest Bolt</div><div class="status"><i>Ongoing</i></div>
        <div class="chapter-list"><a href="/latest-bolt-chapter-44/"><div class="adds new"><div class="epxs">Chapter 44</div><div class="epxdate">NEW</div></div></a></div>
      </div></div><a id="load-more" data-page="2">Load More</a>
    </div>
    <div class="bixbox"><div class="releases"><h2>Latest Novels</h2></div>
      <div class="latest-updates" id="novel-posts"><div class="bsx">
        <a href="/comics/quiet-thunder-novel/" title="Quiet Thunder [Novel]"><img src="/covers/novel.jpg"></a>
        <div class="tt">Quiet Thunder [Novel]</div><span class="novelabel">Novel</span>
        <div class="chapter-list"><a href="/quiet-thunder-novel-chapter-8/"><div class="adds"><div class="epxs">Chapter 8</div><div class="epxdate">1 day</div></div></a></div>
      </div></div><a id="load-more-novel" data-page="3">Load More</a>
    </div>
  </div>
</body></html>`;

export const AJAX_CARDS_HTML = `<div class="bsx">
  <a href="/comics/ajax-tempest/" title="Ajax Tempest"><img src="/covers/ajax.jpg"></a>
  <div class="tt">Ajax Tempest</div>
  <div class="chapter-list"><a href="/ajax-tempest-chapter-7/"><div class="epxs">Chapter 7</div></a></div>
</div>`;

export const SERIES_HTML = `<!doctype html>
<html><head>
  <link rel="canonical" href="https://en-thunderscans.com/comics/storm-architect/">
  <link rel="shortlink" href="https://en-thunderscans.com/?p=4242">
</head><body>
  <div class="main-info">
    <h1 class="entry-title">Storm Architect</h1>
    <div class="alternative"><div class="desktop-titles">폭풍 설계자 | Architect of Storms</div></div>
    <div class="mobile-rt"><div class="numscore">9.4</div></div>
    <div class="genres-container"><span class="mgen">
      <a href="/genres/action/" rel="tag">Action</a><a href="/genres/gore/" rel="tag">Gore</a>
    </span></div>
    <div class="entry-content entry-content-single" itemprop="description">
      <p>A systems engineer wakes inside a city powered by weather.</p><p>Every design has a cost.</p>
    </div>
    <div class="thumb"><img src="/covers/storm-full.jpg" alt="Storm Architect"></div>
    <div class="tsinfo">
      <div class="imptdt"><h1>Type</h1><i>Manhwa</i></div>
      <div class="imptdt"><h1>Status</h1><i>Ongoing</i></div>
      <div class="imptdt"><h1>Released</h1><i>2025</i></div>
      <div class="imptdt"><h1>Author</h1><i>R. Vale</i></div>
      <div class="imptdt"><h1>Artist</h1><i>Blue Current</i></div>
    </div>
  </div>
  <div id="chapterlist"><ul>
    <li data-num="3"><a data-bs-target="#lockedChapterModal" data-id="9003" data-coin="30" data-title="Chapter 3">
      <div class="chbox"><span class="chapternum">Chapter 3</span><span class="chapterdate">August 8, 2026</span><span class="text-gold">30</span></div>
    </a></li>
    <li data-num="2.5"><a href="/storm-architect-chapter-2-5/" data-id="9002" data-coin="10">
      <div class="chbox"><span class="chapternum">Chapter 2.5 — Aftershock</span><span class="chapterdate">August 2, 2026</span><span class="text-gold">10</span></div>
    </a></li>
    <li data-num="1"><a href="https://en-thunderscans.com/storm-architect-chapter-1/">
      <div class="chbox"><span class="chapternum">Chapter 1</span><span class="chapterdate">July 30, 2026</span></div>
    </a></li>
  </ul></div>
</body></html>`;

export const COMIC_READER_HTML = `<!doctype html><html><body>
  <div id="readerarea"></div>
  <script>
    ts_reader.run({"post_id":9002,"noimagehtml":"<p>Nothing (yet)</p>","defaultSource":"high","sources":[{"source":"low","images":["/pages/low-1.jpg"]},{"source":"high","images":["https://cdn.example/page-03.webp","/pages/page 02.webp","/pages/page-01.webp","javascript:alert(1)"]}],"protected":false,"is_novel":false});
  </script>
</body></html>`;

export const NOVEL_READER_HTML = `<!doctype html><html><body>
  <div class="entry-content entry-content-single maincontent novel-shell">
    <div id="readerarea"><h2>Chapter 8</h2><p>The synthetic storm began.<br>Then the lights returned.</p>
      <a href="/glossary/">Glossary</a><script>stealCookies()</script>
    </div>
  </div>
  <script>ts_reader.run({"post_id":8008,"sources":[{"source":"default","images":[]}],"defaultSource":"default","is_novel":true});</script>
</body></html>`;

export const LOCKED_READER_HTML = `<!doctype html><html><body>
  <div class="locked-chapter"><h2>This chapter is locked</h2><p>Buy now for 30 Coins</p></div>
</body></html>`;

export const AUTOCOMPLETE_RESPONSE = {
  series: [
    {
      ID: 4242,
      post_title: "Storm Architect",
      post_image: "/covers/storm.jpg",
      post_genres: ["Action", "Gore"],
      post_type: "Manhwa",
      post_status: "Ongoing",
      post_link: "https://en-thunderscans.com/comics/storm-architect/",
      post_latest: "Chapter 3",
    },
    {
      ID: 8008,
      post_title: "Quiet Thunder [Novel]",
      post_image: "/covers/quiet.jpg",
      post_genres: ["Fantasy"],
      post_type: "Novel",
      post_status: "Completed",
      post_link: "https://en-thunderscans.com/comics/quiet-thunder-novel/",
      post_latest: "Chapter 8",
    },
  ],
};
