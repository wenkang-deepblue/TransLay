// Tweaks panel — lets user toggle design variations

function TweaksPanel({ open, onClose, state, setState }) {
  return (
    <div className={`tweaks-panel ${open ? "open" : ""}`}>
      <h3 className="tweaks-h">
        Tweaks
        <button className="icon-btn" onClick={onClose} aria-label="Close" style={{width: 28, height: 28}}>
          <svg viewBox="0 0 24 24" fill="none" style={{width: 14, height: 14}}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
        </button>
      </h3>

      <div className="tweak-row">
        <label>Hero variation</label>
        <div className="tweaks-seg">
          {["A", "B"].map(v => (
            <button key={v} className={state.hero === v ? "active" : ""} onClick={() => setState({...state, hero: v})}>Variant {v}</button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Background motion</label>
        <div className="tweaks-seg">
          {[{k:0,l:"Still"},{k:1,l:"Slow"},{k:2,l:"Vivid"}].map(o => (
            <button key={o.k} className={state.motion === o.k ? "active" : ""} onClick={() => setState({...state, motion: o.k})}>{o.l}</button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Accent color</label>
        <div className="tweaks-seg">
          {[{k:"blue",l:"Blue"},{k:"violet",l:"Violet"},{k:"cyan",l:"Cyan"}].map(o => (
            <button key={o.k} className={state.accent === o.k ? "active" : ""} onClick={() => setState({...state, accent: o.k})}>{o.l}</button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Font</label>
        <div className="tweaks-seg">
          {[{k:"default",l:"Jakarta"},{k:"geometric",l:"Grotesk"},{k:"serif",l:"Serif"}].map(o => (
            <button key={o.k} className={state.font === o.k ? "active" : ""} onClick={() => setState({...state, font: o.k})}>{o.l}</button>
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Spacing scale — {state.space.toFixed(2)}×</label>
        <input type="range" min="0.8" max="1.3" step="0.05" value={state.space}
          onChange={e => setState({...state, space: parseFloat(e.target.value)})} />
      </div>

      <div className="tweak-row">
        <label>Hero size — {state.hero_size.toFixed(2)}×</label>
        <input type="range" min="0.85" max="1.2" step="0.05" value={state.hero_size}
          onChange={e => setState({...state, hero_size: parseFloat(e.target.value)})} />
      </div>
    </div>
  );
}

// Apply tweaks to :root
function useTweaks(initial) {
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem("translay.tweaks");
      if (stored) return { ...initial, ...JSON.parse(stored) };
    } catch(e) {}
    return initial;
  });
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-accent", state.accent);
    root.setAttribute("data-font", state.font);
    root.style.setProperty("--space-scale", state.space);
    root.style.setProperty("--hero-size", state.hero_size);
    const motionMap = { 0: { opacity: 0, speed: 0 }, 1: { opacity: 0.55, speed: 1 }, 2: { opacity: 0.85, speed: 2 } };
    const m = motionMap[state.motion] || motionMap[1];
    root.style.setProperty("--blob-opacity", m.opacity);
    root.style.setProperty("--blob-speed", m.speed || 0.001);
    localStorage.setItem("translay.tweaks", JSON.stringify(state));
  }, [state]);
  return [state, setState];
}

Object.assign(window, { TweaksPanel, useTweaks });
