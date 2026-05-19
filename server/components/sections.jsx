// Features, demo, pricing, FAQ, CTA sections
const FAQ_SUPPORT_EMAIL = "translay@example.com";
const FAQ_SUPPORT_SUBJECT = "TransLay Support Needed";

function FeatureIcon({ name }) {
  const icons = {
    sparkle: <><path d="M12 3l2.3 5.7L20 11l-5.7 2.3L12 19l-2.3-5.7L4 11l5.7-2.3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none"/></>,
    layout: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M4 10h16M10 10v10" stroke="currentColor" strokeWidth="1.6"/></>,
    globe: <><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" stroke="currentColor" strokeWidth="1.6" fill="none"/></>,
    split: <><path d="M4 12h6M4 6h6a6 6 0 016 6 6 6 0 006 6" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M4 18h6" stroke="currentColor" strokeWidth="1.6"/></>,
    cursor: <><path d="M5 3l5 15 3-7 7-3-15-5z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round"/></>,
    scale: <><path d="M3 20h18M6 16l4-8 4 8M14 20V6l6 10" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round"/></>,
  };
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none">{icons[name]}</svg>
  );
}

function FeatureCard({ icon, title, body, delay = 0 }) {
  return (
    <Reveal delay={delay}>
      <div className="card" style={{padding: 28, height: "100%"}}>
        <div style={{width: 50, height: 50, borderRadius: 14, background: "linear-gradient(135deg, #e8f0fe, #d2e3fc)", display: "grid", placeItems: "center", color: "var(--accent-2)", marginBottom: 18}}>
          <FeatureIcon name={icon} />
        </div>
        <h3 style={{fontFamily: "var(--font-display)", fontSize: 20, margin: "0 0 8px", letterSpacing: "-0.01em"}}>{title}</h3>
        <p style={{margin: 0, color: "var(--text-soft)", fontSize: 15, lineHeight: 1.6}}>{body}</p>
      </div>
    </Reveal>
  );
}

function FeaturesSection({ t }) {
  const items = [
    { icon: "sparkle", title: t.features.f1_title, body: t.features.f1_body },
    { icon: "layout", title: t.features.f2_title, body: t.features.f2_body },
    { icon: "globe", title: t.features.f3_title, body: t.features.f3_body },
    { icon: "split", title: t.features.f4_title, body: t.features.f4_body },
    { icon: "cursor", title: t.features.f5_title, body: t.features.f5_body },
    { icon: "scale", title: t.features.f6_title, body: t.features.f6_body },
  ];
  return (
    <section id="features" className="section">
      <div className="container">
        <div className="section-head">
          <Reveal><span className="kicker"><span className="dot" />{t.features.kicker}</span></Reveal>
          <Reveal delay={60}><h2 className="section-title">{t.features.title}</h2></Reveal>
          <Reveal delay={120}><p className="section-sub">{t.features.subtitle}</p></Reveal>
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 22}}>
          {items.map((it, i) => <FeatureCard key={i} {...it} delay={i * 60} />)}
        </div>
      </div>
    </section>
  );
}

function DemoSection({ t }) {
  const screenshotLabels = t.demo.screenshot_labels || [
    "Function: appending",
    "Function: custom pages",
    "Function: create new file",
  ];
  return (
    <section id="demo" className="section">
      <div className="container">
        <div className="section-head">
          <Reveal><span className="kicker"><span className="dot" />{t.demo.kicker}</span></Reveal>
          <Reveal delay={60}><h2 className="section-title">{t.demo.title}</h2></Reveal>
          {t.demo.subtitle ? <Reveal delay={120}><p className="section-sub">{t.demo.subtitle}</p></Reveal> : null}
        </div>
        <Reveal delay={180}>
          <div className="card" style={{padding: 20, maxWidth: 1020, margin: "0 auto"}}>
            <div style={{aspectRatio: "16/9", borderRadius: 14, overflow: "hidden", background: "linear-gradient(135deg, #eaf1ff, #f5f8ff)", border: "1px solid var(--line)", display: "grid", placeItems: "center", position: "relative"}}>
              <iframe
                src="https://www.youtube-nocookie.com/embed/YOUR_YOUTUBE_VIDEO_ID"
                title="TransLay product demo"
                style={{width: "100%", height: "100%", border: 0}}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          </div>
        </Reveal>

        {/* Screenshots row */}
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 22, marginTop: 40, maxWidth: 1020, margin: "40px auto 0"}}>
          {[1,2,3].map((i) => (
            <Reveal key={i} delay={i * 80}>
              <div className="card" style={{padding: 18}}>
                <div style={{borderRadius: 12, overflow: "hidden", background: "linear-gradient(135deg, #f0f5ff, #fafbff)", border: "1px solid var(--line)"}}>
                  <img src={`assets/translay-${i}.png?v=20260513`} alt={screenshotLabels[i - 1]} style={{display: "block", width: "100%", height: "auto"}} loading="eager" decoding="sync" />
                </div>
                <div style={{fontSize: 13, color: "var(--text-mute)", textAlign: "center", marginTop: 10}}>{screenshotLabels[i - 1]}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function PriceCard({ plan, t, delay = 0, highlight, onPlanCheckout, onCreditsCheckout, onCreditRefund, onPlanCancel, subscriptionState, creditBalance, creditActionCompletedKey }) {
  const p = t.pricing;
  const initialCreditSku = window.TransLayLandingConfig?.getCreditSku?.("slides") || {};
  const [creditQuantity, setCreditQuantity] = React.useState(String(initialCreditSku.minUnits || 18));
  const [refundQuantity, setRefundQuantity] = React.useState("1");
  const [creditPanel, setCreditPanel] = React.useState("");
  const data = {
    free: { name: p.free_name, price: p.free_price, per: null, sub: p.free_sub, features: [p.free_f1, p.free_f2, p.free_f3, p.free_f4], cta: p.free_cta },
    monthly: { name: p.monthly_name, price: p.monthly_price, per: p.monthly_per, sub: p.monthly_sub, features: [p.monthly_f1, p.monthly_f2, p.monthly_f3, p.monthly_f4], cta: p.monthly_cta },
    yearly: { name: p.yearly_name, price: p.yearly_price, per: p.yearly_per, sub: p.yearly_sub, features: [p.yearly_f1, p.yearly_f2, p.yearly_f3, p.yearly_f4], cta: p.yearly_cta, badge: p.yearly_badge },
    payg: { name: p.payg_name, price: p.payg_price, per: p.payg_per, sub: p.payg_sub, features: [p.payg_f1, p.payg_f2, p.payg_f3, p.payg_f4], cta: p.payg_cta },
  }[plan];
  const isSubscriptionPlan = plan === "monthly" || plan === "yearly";
  const mappedPlanType = plan === "monthly" ? "pro_monthly" : plan === "yearly" ? "pro_yearly" : "";
  const isCurrentPlan =
    Boolean(mappedPlanType) && subscriptionState?.currentPlanType === mappedPlanType;
  const cancelScheduled = Boolean(subscriptionState?.cancelAtPeriodEnd);
  const currentPlanType = subscriptionState?.currentPlanType || "";
  const isYearlyActiveOrCanceling = currentPlanType === "pro_yearly";
  const refundableUnits =
    creditBalance && typeof creditBalance.refundable_units === "number"
      ? Math.floor(creditBalance.refundable_units)
      : 0;
  const availableCredits =
    creditBalance && typeof creditBalance.refundable_units === "number"
      ? Math.floor(creditBalance.refundable_units)
      : null;
  const pendingRefundUnits =
    creditBalance && typeof creditBalance.pending_refund_units === "number"
      ? Math.floor(creditBalance.pending_refund_units)
      : 0;
  const creditSku = window.TransLayLandingConfig?.getCreditSku?.("slides") || {};
  const purchaseMinUnits = Number.isInteger(creditSku.minUnits) ? creditSku.minUnits : 18;
  const purchaseMaxUnits = Number.isInteger(creditSku.maxUnits) ? creditSku.maxUnits : 100;
  const normalizePurchaseQuantity = (value, clampIncomplete = false) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return clampIncomplete ? String(purchaseMinUnits) : value;
    }
    if (parsed > purchaseMaxUnits) {
      return String(purchaseMaxUnits);
    }
    if (
      parsed < purchaseMinUnits &&
      (clampIncomplete || String(Math.abs(parsed)).length >= String(purchaseMinUnits).length)
    ) {
      return String(purchaseMinUnits);
    }
    return value;
  };
  React.useEffect(() => {
    if (refundableUnits > 0 && Number(refundQuantity) > refundableUnits) {
      setRefundQuantity(String(refundableUnits));
    }
  }, [refundableUnits, refundQuantity]);
  React.useEffect(() => {
    if (creditPanel === "refund" && refundableUnits <= 0) {
      setCreditPanel("");
    }
  }, [creditPanel, refundableUnits]);
  React.useEffect(() => {
    setCreditPanel("");
  }, [creditActionCompletedKey]);
  const parseUnitInput = (value, min, max) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return null;
    }
    if (parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  };
  const purchaseQuantity = parseUnitInput(creditQuantity, purchaseMinUnits, purchaseMaxUnits);
  const refundableQuantity = parseUnitInput(refundQuantity, 1, refundableUnits);
  const creditInputStyle = {
    width: "100%",
    height: 42,
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "0 12px",
    font: "inherit",
    background: "var(--surface)",
    color: "var(--text)",
    textAlign: "center",
  };
  const buttonState = (() => {
    if (!isSubscriptionPlan) {
      return { label: data.cta, disabled: false, action: plan === "payg" ? "credits" : "link" };
    }

    if (plan === "monthly" && isYearlyActiveOrCanceling) {
      return { label: p.monthly_cta, disabled: true, action: "none" };
    }

    if (isCurrentPlan && cancelScheduled) {
      return {
        label: mappedPlanType === "pro_yearly" ? p.resume_yearly_cta : p.resume_monthly_cta,
        disabled: false,
        action: "resume",
      };
    }

    if (isCurrentPlan) {
      return { label: p.cancel_cta, disabled: false, action: "cancel" };
    }

    if (plan === "yearly" && currentPlanType === "pro_monthly") {
      return { label: p.upgrade_yearly_cta, disabled: false, action: "upgrade" };
    }

    return { label: data.cta, disabled: false, action: "checkout" };
  })();
  return (
    <Reveal delay={delay}>
      <div className="card" style={{padding: 28, height: "100%", display: "flex", flexDirection: "column", position: "relative", ...(highlight ? {borderColor: "rgba(66,133,244,0.4)", boxShadow: "0 10px 40px rgba(66,133,244,0.15)"} : {})}}>
        {data.badge && (
          <span style={{position: "absolute", top: -12, insetInlineStart: 24, background: "var(--accent-grad)", color: "white", fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", padding: "5px 12px", borderRadius: 999, boxShadow: "0 6px 16px rgba(66,133,244,0.35)"}}>{data.badge}</span>
        )}
        <div style={{
          display: "flex",
          flexDirection: plan === "payg" ? "column" : "row",
          alignItems: plan === "payg" ? "flex-start" : "center",
          justifyContent: plan === "payg" ? "center" : "flex-start",
          gap: plan === "payg" ? 10 : 12,
          minHeight: 88,
          marginBottom: 8,
          textAlign: "start",
        }}>
          <div style={{fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, color: "var(--text-soft)"}}>{data.name}</div>
          {plan === "payg" && availableCredits !== null ? (
            <div style={{
              fontSize: 12,
              color: "#188038",
              lineHeight: 1.45,
              maxWidth: "100%",
              overflowWrap: "anywhere",
              textAlign: "center",
              transform: "translateY(4px)",
            }}>
              {pendingRefundUnits > 0 ? (
                <>
                  {p.credits_refund_in_progress_label || "Refunding"}:{" "}
                  <span style={{fontWeight: 600}}>{pendingRefundUnits.toLocaleString()}</span>
                  {" · "}
                </>
              ) : null}
              {p.payg_available_credits_label || "Credits left"}:{" "}
              <span style={{fontWeight: 600}}>{availableCredits.toLocaleString()}</span>
            </div>
          ) : null}
        </div>
        <div style={{display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6}}>
          <span style={{fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 700, letterSpacing: "-0.02em"}}>{data.price}</span>
          {data.per && <span style={{fontSize: 16, color: "var(--text-mute)"}}>{data.per}</span>}
        </div>
        <div style={{fontSize: 13, color: "var(--text-mute)", marginBottom: 22}}>{data.sub}</div>
        <ul style={{listStyle: "none", padding: 0, margin: "0 0 24px", display: "flex", flexDirection: "column", gap: 10, flex: 1}}>
          {data.features.map((f, i) => (
            <li key={i} style={{display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14.5, color: "var(--text-soft)"}}>
              {plan === "payg" && i === 3 ? (
                <span style={{width: 16, flexShrink: 0, marginTop: 2, color: "var(--accent)", fontWeight: 700, textAlign: "center"}}>*</span>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink: 0, marginTop: 3}}><path d="M5 12l5 5 9-11" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
              {f}
            </li>
          ))}
        </ul>
        {isSubscriptionPlan ? (
          <button
            type="button"
            className="btn btn-pricing-cta"
            data-fit-button-group="pricing-card-actions"
            style={{justifyContent: "center"}}
            disabled={buttonState.disabled}
            onClick={() => {
              if (buttonState.action === "cancel") {
                onPlanCancel?.(mappedPlanType);
                return;
              }
              if (buttonState.action === "resume" || buttonState.action === "upgrade") {
                onPlanCheckout?.(mappedPlanType, { action: buttonState.action });
                return;
              }
              if (buttonState.action === "checkout") {
                onPlanCheckout?.(mappedPlanType, { action: "checkout" });
              }
            }}
          >
            {buttonState.label}
          </button>
        ) : buttonState.action === "credits" ? (
          <div style={{display: "flex", flexDirection: "column", gap: 10}}>
            {!creditPanel ? (
              <>
                <button
                  type="button"
                  className="btn btn-pricing-cta payg-action-btn"
                  data-fit-button-group="pricing-card-actions"
                  style={{justifyContent: "center"}}
                  onClick={() => setCreditPanel("purchase")}
                >
                  {p.payg_buy_entry_cta || "Buy pay-as-you-go credits"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost payg-action-btn"
                  data-fit-button-group="pricing-card-actions"
                  style={{justifyContent: "center"}}
                  disabled={refundableUnits <= 0}
                  onClick={() => setCreditPanel("refund")}
                >
                  {p.payg_refund_entry_cta || "Refund unused credits"}
                </button>
              </>
            ) : (
              <>
                <input
                  type="number"
                  min={creditPanel === "purchase" ? purchaseMinUnits : 1}
                  max={creditPanel === "purchase" ? purchaseMaxUnits : refundableUnits}
                  step="1"
                  aria-label={
                    creditPanel === "purchase"
                      ? p.credits_quantity_label || "Slides to buy"
                      : p.credits_refund_quantity_label || "Slides to refund"
                  }
                  value={creditPanel === "purchase" ? creditQuantity : refundQuantity}
                  onChange={(event) => {
                    if (creditPanel === "purchase") {
                      setCreditQuantity(normalizePurchaseQuantity(event.target.value));
                    } else {
                      setRefundQuantity(event.target.value);
                    }
                  }}
                  onBlur={() => {
                    if (creditPanel === "purchase") {
                      setCreditQuantity((value) => normalizePurchaseQuantity(value, true));
                    }
                  }}
                  style={creditInputStyle}
                />
                <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
                  <button
                    type="button"
                    className="btn btn-ghost payg-action-btn"
                    data-fit-button-group="pricing-credit-panel-actions"
                    style={{justifyContent: "center"}}
                    onClick={() => setCreditPanel("")}
                  >
                    {p.credits_cancel_cta || "Cancel"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-pricing-cta payg-action-btn"
                    data-fit-button-group="pricing-credit-panel-actions"
                    style={{justifyContent: "center"}}
                    disabled={creditPanel === "purchase" ? !purchaseQuantity : !refundableQuantity}
                    onClick={() => {
                      if (creditPanel === "purchase" && purchaseQuantity) {
                        onCreditsCheckout?.(purchaseQuantity);
                        return;
                      }
                      if (creditPanel === "refund" && refundableQuantity) {
                        onCreditRefund?.(refundableQuantity);
                      }
                    }}
                  >
                    {creditPanel === "purchase"
                      ? p.credits_purchase_cta || "Buy"
                      : p.credits_refund_cta || "Refund"}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <a href="#install" className="btn btn-pricing-cta" data-fit-button-group="pricing-card-actions" style={{justifyContent: "center"}}>{data.cta}</a>
        )}
      </div>
    </Reveal>
  );
}

function PricingSection({ t, onPlanCheckout, onCreditsCheckout, onCreditRefund, onPlanCancel, checkoutNotice, subscriptionState, creditBalance, creditActionCompletedKey }) {
  return (
    <section id="pricing" className="section">
      <div className="container">
        <div className="section-head">
          <Reveal><span className="kicker"><span className="dot" />{t.pricing.kicker}</span></Reveal>
          <Reveal delay={60}><h2 className="section-title">{t.pricing.title}</h2></Reveal>
          <Reveal delay={120}><p className="section-sub">{t.pricing.subtitle}</p></Reveal>
          {checkoutNotice ? (
            <Reveal delay={140}>
              <div className="pricing-notice" role="status" aria-live="polite">
                {checkoutNotice}
              </div>
            </Reveal>
          ) : null}
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 22, alignItems: "stretch"}}>
          <PriceCard plan="free" t={t} delay={0} onPlanCheckout={onPlanCheckout} onCreditsCheckout={onCreditsCheckout} onCreditRefund={onCreditRefund} onPlanCancel={onPlanCancel} subscriptionState={subscriptionState} creditBalance={creditBalance} creditActionCompletedKey={creditActionCompletedKey} />
          <PriceCard plan="monthly" t={t} delay={60} onPlanCheckout={onPlanCheckout} onCreditsCheckout={onCreditsCheckout} onCreditRefund={onCreditRefund} onPlanCancel={onPlanCancel} subscriptionState={subscriptionState} creditBalance={creditBalance} creditActionCompletedKey={creditActionCompletedKey} />
          <PriceCard plan="yearly" t={t} delay={120} highlight onPlanCheckout={onPlanCheckout} onCreditsCheckout={onCreditsCheckout} onCreditRefund={onCreditRefund} onPlanCancel={onPlanCancel} subscriptionState={subscriptionState} creditBalance={creditBalance} creditActionCompletedKey={creditActionCompletedKey} />
          <PriceCard plan="payg" t={t} delay={180} onPlanCheckout={onPlanCheckout} onCreditsCheckout={onCreditsCheckout} onCreditRefund={onCreditRefund} onPlanCancel={onPlanCancel} subscriptionState={subscriptionState} creditBalance={creditBalance} creditActionCompletedKey={creditActionCompletedKey} />
        </div>
      </div>
    </section>
  );
}

function renderFaqAnswer(answer, supportSubjectValue) {
  const supportEmail =
    typeof window.SUPPORT_EMAIL === "string" && window.SUPPORT_EMAIL.trim()
      ? window.SUPPORT_EMAIL.trim()
      : FAQ_SUPPORT_EMAIL;
  const supportSubject =
    typeof supportSubjectValue === "string" && supportSubjectValue.trim()
      ? supportSubjectValue.trim()
      : typeof window.SUPPORT_SUBJECT === "string" && window.SUPPORT_SUBJECT.trim()
        ? window.SUPPORT_SUBJECT.trim()
        : FAQ_SUPPORT_SUBJECT;
  const mailtoHref = `mailto:${supportEmail}?subject=${encodeURIComponent(supportSubject)}`;

  const parts = String(answer || "").split(supportEmail);
  if (parts.length === 1) {
    return answer;
  }

  return parts.flatMap((part, index) => {
    if (index === parts.length - 1) {
      return part;
    }
    return [
      part,
      <a key={`support-${index}`} href={mailtoHref} style={{color: "var(--accent-2)"}}>
        {supportEmail}
      </a>,
    ];
  });
}

function FAQItem({ q, a, idx, supportSubject }) {
  const [open, setOpen] = useState(false);
  return (
    <Reveal delay={idx * 50}>
      <div className="card" style={{padding: 0, overflow: "hidden", marginBottom: 12}}>
        <button onClick={() => setOpen(o => !o)} style={{
          width: "100%", padding: "22px 26px", background: "transparent", border: "none", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "start",
          fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 17, color: "var(--text)"
        }}>
          <span>{q}</span>
          <span style={{width: 28, height: 28, borderRadius: "50%", background: "var(--bg-soft)", display: "grid", placeItems: "center", flexShrink: 0, marginInlineStart: 16, transition: "transform 0.3s", transform: open ? "rotate(45deg)" : "none"}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round"/></svg>
          </span>
        </button>
        <div style={{maxHeight: open ? 420 : 0, overflow: "hidden", transition: "max-height 0.4s ease"}}>
          <div style={{padding: "0 26px 22px", color: "var(--text-soft)", fontSize: 15, lineHeight: 1.65}}>{renderFaqAnswer(a, supportSubject)}</div>
        </div>
      </div>
    </Reveal>
  );
}

function FAQSection({ t }) {
  const items = [
    { q: t.faq.q1, a: t.faq.a1 },
    { q: t.faq.q2, a: t.faq.a2 },
    { q: t.faq.q3, a: t.faq.a3 },
    { q: t.faq.q4, a: t.faq.a4 },
    { q: t.faq.q5, a: t.faq.a5 },
    { q: t.faq.q6, a: t.faq.a6 },
    { q: t.faq.q7, a: t.faq.a7 },
  ];
  return (
    <section id="faq" className="section">
      <div className="container">
        <div className="section-head">
          <Reveal><span className="kicker"><span className="dot" />{t.faq.kicker}</span></Reveal>
          <Reveal delay={60}><h2 className="section-title">{t.faq.title}</h2></Reveal>
        </div>
        <div style={{maxWidth: 780, margin: "0 auto"}}>
          {items.map((it, i) => <FAQItem key={i} {...it} idx={i} supportSubject={t.footer.support_subject} />)}
        </div>
      </div>
    </section>
  );
}

function CTASection({ t }) {
  return (
    <section className="section-sm">
      <div className="container">
        <Reveal>
          <div className="card" style={{padding: "60px 40px", textAlign: "center", background: "linear-gradient(135deg, rgba(66,133,244,0.08), rgba(26,115,232,0.04))", border: "1px solid rgba(66,133,244,0.2)", maxWidth: 900, margin: "0 auto"}}>
            <h2 className="section-title" style={{margin: "0 0 12px"}}>{t.cta.title}</h2>
            <p style={{color: "var(--text-soft)", fontSize: 17, margin: "0 0 28px"}}>{t.cta.subtitle}</p>
            <a className="btn btn-primary btn-lg" href="#install" data-fit-button-group="final-cta-actions">
              {t.cta.button}
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

Object.assign(window, { FeaturesSection, DemoSection, PricingSection, FAQSection, CTASection });
