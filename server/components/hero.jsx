// Hero section — 5-group 16:9 slide carousel with crossfade within, slide+fade between

// 5 demo groups — each is a pair: original + translated
const DEMO_GROUPS = [
  {
    id: "group-1",
    imgOriginal: "assets/group-1-1.png",
    imgTranslated: "assets/group-1-2.png",
  },
  {
    id: "group-2",
    imgOriginal: "assets/group-2-1.png?v=2",
    imgTranslated: "assets/group-2-2.png?v=2",
  },
  {
    id: "group-3",
    imgOriginal: "assets/group-3-1.png",
    imgTranslated: "assets/group-3-2.png",
  },
  {
    id: "group-4",
    imgOriginal: "assets/group-4-1.png",
    imgTranslated: "assets/group-4-2.png",
  },
  {
    id: "group-5",
    imgOriginal: "assets/group-5-1.png",
    imgTranslated: "assets/group-5-2.png",
  },
];

// 16:9 slide card — renders ORIGINAL or TRANSLATED side of a group
function DemoSlide({ group, side }) {
  const src = side === "trans" ? group.imgTranslated : group.imgOriginal;
  const sideLabel = side === "trans" ? "translated" : "original";
  return (
    <div className="demo-slide">
      <img className="demo-slide-image" src={src} alt={`TransLay ${group.id} ${sideLabel} screenshot`} loading="eager" decoding="async" />
    </div>
  );
}

/**
 * SlideCarousel — "film strip" model
 *   Two groups are mounted side-by-side on a single track:
 *     [ current | gap | next ]
 *   During transition, the ENTIRE track slides left so next moves into center
 *   while current moves out — they travel together at the same speed (no gap).
 *
 * Timings:
 *   dwell per group: 7s total (within-group crossfade original->translated at 3s)
 *   between-group slide: 1.1s (track translates by 100% + gap)
 *   outgoing fade-out: 0.55s (faster than slide) — so it's gone before reaching left text
 *
 * Distances / values to remember (v1 — restore point):
 *   - Gap between film cells: 8% of carousel width
 *   - Slide distance: -(100% + gap) on the track
 *   - Slide duration: 1.1s cubic-bezier(.45,.05,.25,1)
 *   - Outgoing opacity transition: 0.55s ease-in
 *   - Incoming opacity transition: 0.9s ease-out (same as before)
 */
function SlideCarousel() {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [sideIdx, setSideIdx]   = useState(0); // 0 original, 1 translated
  const [sliding, setSliding]   = useState(false); // true during between-group slide
  const [committing, setCommitting] = useState(false); // one-frame flag to suppress transitions during commit

  // Tunables (v1)
  const GAP_PCT = 8;              // % of carousel width between cells
  const SLIDE_MS = 1100;           // duration of slide
  const FADE_OUT_MS = 550;         // faster fade-out of outgoing group
  const FADE_IN_MS = 900;          // incoming fade-in
  const DWELL_MS = 5000;           // how long each group stays centered (2s orig + 2s translated + crossfade)
  const SIDE_SWITCH_MS = 2000;     // when to crossfade original -> translated

  useEffect(() => {
    const timeouts = [];
    // Crossfade to translated at t=3s
    timeouts.push(setTimeout(() => setSideIdx(1), SIDE_SWITCH_MS));
    // Begin slide at t=7s
    timeouts.push(setTimeout(() => setSliding(true), DWELL_MS));
    // After slide completes, commit in two steps to avoid flash:
    //   1. Set `committing` true → transitions disabled on next render
    //   2. In that disabled frame, swap currentIdx + reset sliding/sideIdx
    //   3. Clear committing on the frame after, re-enable normal transitions
    timeouts.push(setTimeout(() => {
      setCommitting(true);
      setCurrentIdx((g) => (g + 1) % DEMO_GROUPS.length);
      setSideIdx(0);
      setSliding(false);
      // next animation frame: release the transition lock
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setCommitting(false));
      });
    }, DWELL_MS + SLIDE_MS));
    return () => timeouts.forEach(clearTimeout);
  }, [currentIdx]);

  const current = DEMO_GROUPS[currentIdx];
  const next    = DEMO_GROUPS[(currentIdx + 1) % DEMO_GROUPS.length];

  // Track transform: when sliding, shift left by (100% + GAP)
  const trackTransform = sliding
    ? `translateX(calc(-100% - ${GAP_PCT}%))`
    : `translateX(0%)`;

  return (
    <div className="slide-carousel">
      {/* clip mask keeps slides visible only over the carousel width */}
      <div className="slide-carousel-viewport">
        <div
          className="slide-carousel-filmstrip"
          style={{
            transform: trackTransform,
            transition: (committing || !sliding)
              ? "none"
              : `transform ${SLIDE_MS}ms cubic-bezier(.45,.05,.25,1)`,
            gap: `${GAP_PCT}%`,
          }}
        >
          {/* CURRENT cell */}
          <div
            className="slide-carousel-cell"
            style={{
              opacity: sliding ? 0 : 1,
              transition: committing
                ? "none"
                : (sliding ? `opacity ${FADE_OUT_MS}ms ease-in` : `opacity ${FADE_IN_MS}ms ease`),
            }}
          >
            {/* crossfade layers within current */}
            <div className="slide-carousel-layer" style={{ opacity: sideIdx === 0 ? 1 : 0, transition: committing ? "none" : `opacity ${FADE_IN_MS}ms ease` }}>
              <DemoSlide group={current} side="orig" />
            </div>
            <div className="slide-carousel-layer" style={{ opacity: sideIdx === 1 ? 1 : 0, transition: committing ? "none" : `opacity ${FADE_IN_MS}ms ease` }}>
              <DemoSlide group={current} side="trans" />
            </div>
          </div>

          {/* NEXT cell — starts at 100%+GAP to the right of current, rides the same track */}
          <div
            className="slide-carousel-cell"
            style={{
              opacity: sliding ? 1 : 0,
              transition: committing
                ? "none"
                : (sliding ? `opacity ${FADE_IN_MS}ms ease-out` : "none"),
            }}
          >
            <div className="slide-carousel-layer" style={{ opacity: 1 }}>
              <DemoSlide group={next} side="orig" />
            </div>
          </div>
        </div>
      </div>

      {/* indicator dots */}
      <div className="slide-carousel-dots">
        {DEMO_GROUPS.map((_, i) => (
          <span key={i} className={`dot ${i === currentIdx ? "active" : ""}`} />
        ))}
      </div>
    </div>
  );
}

// HERO VARIATION A — left copy + carousel on right
function HeroA({ t }) {
  return (
    <section className="section" style={{paddingTop: "calc(100px * var(--space-scale))", paddingBottom: "calc(80px * var(--space-scale))"}}>
      <div className="container hero-grid" style={{alignItems: "center", paddingTop: 20}}>
        <div>
          <Reveal>
            <span className="kicker"><span className="dot" />{t.hero.badge}</span>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="section-title" style={{fontSize: "clamp(44px, 5.6vw, 72px)", marginTop: 22, textAlign: "start"}}>
              {t.hero.title1}<br/>
              <span style={{background: "var(--accent-grad)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent"}}>
                {t.hero.title2}
              </span>
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p style={{fontSize: 19, color: "var(--text-soft)", maxWidth: 520, margin: "18px 0 32px"}}>{t.hero.subtitle}</p>
          </Reveal>
          <Reveal delay={220}>
            <div style={{display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap"}}>
              <a className="btn btn-primary btn-lg" href="#install" id="install" data-fit-button-group="hero-actions">
                {t.hero.cta}
                <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </a>
              <a className="btn btn-ghost btn-lg" href="#demo" data-fit-button-group="hero-actions">
                <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/></svg>
                {t.hero.secondary}
              </a>
            </div>
          </Reveal>
          <Reveal delay={300}>
            <div style={{marginTop: 20, display: "flex", alignItems: "center", gap: 8, color: "var(--text-mute)", fontSize: 13}}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M5 12l5 5 9-11" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              {t.hero.cta_sub}
            </div>
          </Reveal>
        </div>

        <div className="hero-collage">
          <SlideCarousel />
        </div>
      </div>
    </section>
  );
}

// HERO VARIATION B — centered bold with carousel below
function HeroB({ t }) {
  const h2 = t.hero2;
  return (
    <section className="section" style={{paddingTop: "calc(110px * var(--space-scale))", paddingBottom: "calc(60px * var(--space-scale))"}}>
      <div className="container" style={{textAlign: "center"}}>
        <Reveal><span className="kicker"><span className="dot" />{h2.badge}</span></Reveal>
        <Reveal delay={80}>
          <h1 className="section-title" style={{fontSize: "clamp(52px, 7vw, 96px)", lineHeight: 1.02, marginTop: 26, letterSpacing: "-0.03em"}}>
            {h2.title}<br/>
            <span style={{background: "var(--accent-grad)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent"}}>{h2.title_accent}</span><br/>
            <span style={{color: "var(--text-soft)", fontWeight: 500}}>{h2.title_end}</span>
          </h1>
        </Reveal>
        <Reveal delay={160}>
          <p style={{fontSize: 19, color: "var(--text-soft)", maxWidth: 620, margin: "24px auto 36px"}}>{h2.subtitle}</p>
        </Reveal>
        <Reveal delay={220}>
          <div style={{display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap"}}>
            <a className="btn btn-primary btn-lg" href="#install-b" data-fit-button-group="hero-actions">
              {t.hero.cta}
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </a>
            <a className="btn btn-ghost btn-lg" href="#demo" data-fit-button-group="hero-actions">{t.hero.secondary}</a>
          </div>
        </Reveal>
      </div>

      <Reveal delay={320}>
        <div className="container" style={{marginTop: 60, maxWidth: 960}}>
          <SlideCarousel />
        </div>
      </Reveal>
    </section>
  );
}

function Hero({ t, variant }) {
  return variant === "B" ? <HeroB t={t} /> : <HeroA t={t} />;
}

// Keep sidebar mock exported for demo section use
function TransLaySidebarMock({ variant = 1 }) {
  const variants = [
    { src: "Auto-detect", tgt: "German", range: "Entire presentation", out: "Create a new presentation" },
    { src: "English", tgt: "Tibetan", range: "Entire presentation", out: "Append after each slide" },
    { src: "Auto-detect", tgt: "日本語 (formal)", range: "Slides 1–12", out: "Create a new presentation" },
  ];
  const v = variants[(variant - 1) % variants.length];
  return (
    <div className="sidebar-mock" style={{fontSize: 13}}>
      <div className="sidebar-mock-head">
        <span style={{fontWeight: 600}}>TransLay</span>
        <span style={{color: "#888", cursor: "pointer"}}>×</span>
      </div>
      <div className="sidebar-mock-body">
        <div className="sidebar-mock-logo">
          <img className="sidebar-mock-logo-image" src="assets/TransLay-logo_48px.png?v=20260428" alt="" />
          <strong style={{fontSize: 15}}>TransLay</strong>
        </div>
        <div style={{padding: "10px 12px", background: "#f3f5f9", borderRadius: 6, marginTop: 12, fontSize: 11, color:"#333"}}>
          <div style={{fontWeight: 500}}>OCI Pitch Deck — 101-en</div>
          <div style={{color: "#888", marginTop: 2, fontSize: 10}}>Google Slides™</div>
        </div>
        <div className="sidebar-pill">
          <span className="sidebar-pill-label">PRO</span>
          <div className="sidebar-pill-row"><span>Slides</span><span style={{fontWeight:600}}>78 / 500</span></div>
          <div className="sidebar-pill-row"><span>Docs pages</span><span style={{color:"#888"}}>Coming soon</span></div>
          <div className="sidebar-pill-row"><span>Sheets cells</span><span style={{color:"#888"}}>Coming soon</span></div>
        </div>
        <div className="sidebar-mock-field">
          <div className="lab">Source Language</div>
          <div className="inp">{v.src}<svg viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg></div>
        </div>
        <div className="sidebar-mock-field">
          <div className="lab">Target Language</div>
          <div className="inp" style={{color: "var(--accent-2)", fontWeight: 600}}>{v.tgt}<svg viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg></div>
        </div>
        <div className="sidebar-mock-field">
          <div className="lab">Translation Range</div>
          <div className="inp">{v.range}<svg viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg></div>
        </div>
        <div className="sidebar-mock-field">
          <div className="lab">Output Mode</div>
          <div className="inp">{v.out}<svg viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg></div>
        </div>
        <div className="sidebar-mock-btn primary">Translate</div>
        <div className="sidebar-mock-btn secondary">Manage Subscription</div>
      </div>
    </div>
  );
}

Object.assign(window, { Hero, HeroA, HeroB, TransLaySidebarMock, SlideCarousel, DemoSlide, DEMO_GROUPS });
