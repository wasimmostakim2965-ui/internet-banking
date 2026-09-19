import { useEffect, useState, type FormEvent } from 'react';
import Auth from './Auth';
import Dashboard from './Dashboard';
import { AdminPanel, InvestorPreview } from './Demo';
import { supabase } from './lib/supabase';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Globe2, Lock, Menu, Send, ShieldCheck, Wallet, X, CreditCard, BarChart3, Users, Sparkles } from 'lucide-react';

type Page = 'home' | 'dashboard' | 'auth' | 'platform';

const products = [
  { icon: Send, title: 'Receive payments', text: 'Get paid by clients, customers and platforms with one global account built for momentum.', tag: 'GET PAID' },
  { icon: Users, title: 'Pay teams and suppliers', text: 'Send payments to the people you work with—quickly, clearly and with the right controls.', tag: 'SEND PAYMENTS' },
  { icon: Wallet, title: 'Manage cashflow', text: 'See balances, currencies and activity together, so every decision starts with context.', tag: 'STAY IN CONTROL' },
  { icon: CreditCard, title: 'Spend with confidence', text: 'Give your team the freedom to move and the guardrails your business needs to grow.', tag: 'SPEND SMARTER' },
];

function App() {
  const initialPath = window.location.pathname.replace(/\/+$/, '') || '/';
  const initialPage: Page = initialPath === '/signin' ? 'auth' : initialPath === '/signup' ? 'auth' : initialPath === '/platform' ? 'platform' : initialPath === '/dashboard' ? 'dashboard' : 'home';
  const [page, setPage] = useState<Page>(initialPage);
  const [menu, setMenu] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [authMode, setAuthMode] = useState<'signup' | 'signin'>(initialPath === '/signin' ? 'signin' : 'signup');
  const openPublicPage = (target: 'signin' | 'signup' | 'platform') => {
    window.history.pushState({}, '', `/${target}`);
    if (target === 'platform') setPage('platform');
    else { setAuthMode(target); setPage('auth'); }
    const titles: Record<string, string> = { '/signin': 'Sign in to Paywai — Global Financial Account', '/signup': 'Create your Paywai account — Global Financial Platform', '/platform': 'Paywai Platform — Payments, Balances & Financial Control' };
    document.title = titles[`/${target}`];
  };

  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Paywai — Global Payments, Balances & Financial Control',
      '/signin': 'Sign in to Paywai — Global Financial Account',
      '/signup': 'Create your Paywai account — Global Financial Platform',
      '/platform': 'Paywai Platform — Payments, Balances & Financial Control',
      '/dashboard': 'Paywai Dashboard — Your Financial Workspace',
    };
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
    document.title = titles[currentPath] || 'Paywai — Global Financial Platform';
    const canonicalUrl = currentPath === '/platform' ? 'https://xonomo.site/platform' : 'https://xonomo.site/';
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.appendChild(canonical); }
    canonical.href = canonicalUrl;
    const privateRoute = currentPath === '/signin' || currentPath === '/signup' || currentPath === '/dashboard' || currentPath.startsWith('/control-') || currentPath.startsWith('/i/');
    let robots = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
    robots.content = privateRoute ? 'noindex,nofollow' : 'index,follow,max-image-preview:large';
    const handlePopState = () => {
      const nextPath = window.location.pathname.replace(/\/+$/, '') || '/';
      const nextPage: Page = nextPath === '/signin' || nextPath === '/signup' ? 'auth' : nextPath === '/platform' ? 'platform' : nextPath === '/dashboard' ? 'dashboard' : 'home';
      if (nextPage === 'auth') setAuthMode(nextPath === '/signin' ? 'signin' : 'signup');
      setPage(nextPage);
    };
    window.addEventListener('popstate', handlePopState);
    void supabase.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session)); if(session && window.localStorage.getItem('paywai_google_signup')==='1'){setAuthMode('signup');setPage('auth');} });
    return () => {
      window.removeEventListener('popstate', handlePopState);
      data.subscription.unsubscribe();
    };
  }, []);

  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  // PRIVATE ADMIN ROUTE: https://xonomo.site/control-9f2d8c7a4e1b6f03d5a9c8e2b7f14a60c3d8e5a1b9f6c2d7e4a0b8c5f1d3e6a9
  // Public IP allowlist: 121.200.220.137
  if (path === '/control-9f2d8c7a4e1b6f03d5a9c8e2b7f14a60c3d8e5a1b9f6c2d7e4a0b8c5f1d3e6a9') return <SecretAdminGate />;
  if (path === '/admin') return <NotFoundPage />;
  if (path.startsWith('/i/')) return <InvestorPreview token={decodeURIComponent(path.slice(3).split('/')[0])} />;

  if (page === 'dashboard') return <Dashboard onBack={() => setPage('home')} />;
  if (page === 'auth')
    return (
      <Auth
        initialMode={authMode}
        onBack={() => setPage('home')}
        onSuccess={() => setPage('dashboard')}
      />
    );
  if (page === 'platform') return <PlatformPage onBack={() => setPage('home')} onStart={() => openPublicPage('signup')} />;

  return <div className="site">
    <header className="header">
      <button className="logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><span>P</span>PAYWAI</button>
      <nav><a href="#products">Products <ChevronDown size={14} /></a><a href="#audiences">Who we serve</a><a href="#why">Why Paywai</a><a href="#resources">Resources</a></nav>
      <div className="head-actions"><button onClick={() => { setAuthMode('signin'); if (signedIn) { window.history.pushState({}, '', '/dashboard'); setPage('dashboard'); } else { openPublicPage('signin'); }; }}>Sign in</button><button className="primary" onClick={() => { openPublicPage('signup'); }}>Get started <ArrowRight size={15} /></button></div>
      <button className="menu" aria-label="Open navigation" onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button>
    </header>
    {menu && <div className="mobile-nav"><a href="#products" onClick={() => setMenu(false)}>Products</a><a href="#audiences" onClick={() => setMenu(false)}>Who we serve</a><a href="#why" onClick={() => setMenu(false)}>Why Paywai</a><a href="#resources" onClick={() => setMenu(false)}>Resources</a><button onClick={() => { setMenu(false); if (signedIn) { window.history.pushState({}, '', '/dashboard'); setPage('dashboard'); } else { openPublicPage('signin'); }; }}>Sign in</button><button onClick={() => { setMenu(false); openPublicPage('signup'); }}>Get started</button></div>}
    <main>
      <section className="hero-new">
        <div className="hero-new-copy">
          <div className="eyebrow">FOR PEOPLE AND BUSINESSES THAT THINK GLOBAL</div>
          <h1>Move money. <em>Grow without limits.</em></h1>
          <p>Payments, balances and financial controls — all in one place.</p>
          <div className="hero-actions"><button className="primary large" onClick={() => openPublicPage('signup')}>Create your account <ArrowRight size={17} /></button></div>
          <div className="hero-proof"><span><Check size={14} /> Clear account controls</span><span><Check size={14} /> Email-verified access</span></div><div className="hero-disclosure">Paywai is currently a prototype. Live financial rails are not connected.</div>
        </div>
        <div className="hero-art" aria-label="Paywai account preview"><div className="glow" /><div className="money-card primary-card"><div className="card-top"><span>PAYWAI</span><span>•••</span></div><div className="card-chip" /><strong>GLOBAL ACCOUNT</strong><small>CONTROL · CLARITY · MOVEMENT</small></div><div className="account-card"><div className="account-head"><span>AVAILABLE BALANCE</span><b>USD · TEST</b></div><strong>$24,680.00</strong><div className="account-foot"><span><i className="dot green" /> Ready to move</span><span>•••</span></div></div><div className="transfer-card"><div><span className="avatar">A</span><span><b>Atlas Studio</b><small>Payment received</small></span></div><strong>+$4,250</strong></div></div>
      </section>
      <section className="logo-strip"><span>ONE ACCOUNT FOR YOUR GLOBAL FINANCES</span><div><b>GET PAID</b><b>SEND PAYMENTS</b><b>MANAGE CASHFLOW</b><b>SPEND WITH CONTROL</b><b>GROW GLOBALLY</b></div></section>
      <section id="products" className="section product-section"><div className="section-head"><div><div className="eyebrow">ONE PLATFORM. EVERY BUSINESS MOVE.</div><h2>Powerful tools to help you <em>go further.</em></h2></div><p>Everything you need to get paid, move money, manage your operation and build what comes next—all in one beautifully simple account.</p></div><div className="product-grid">{products.map(({ icon: Icon, title, text, tag }, index) => <article className="product-tile" key={title}><div className="tile-top"><span>0{index + 1}</span><div className="tile-icon"><Icon /></div></div><small>{tag}</small><h3>{title}</h3><p>{text}</p><a href="#why">Explore {title.toLowerCase()} <ArrowRight size={14} /></a></article>)}</div></section>
      <section id="audiences" className="audience-section"><div className="audience-copy"><div className="eyebrow">BUILT AROUND YOUR AMBITION</div><h2>One platform.<br /><em>More possibilities.</em></h2><p>Whether you are building a global company or building a life across borders, your money should work with you—not slow you down.</p><button className="text" onClick={() => { if (signedIn) { window.history.pushState({}, '', '/dashboard'); setPage('dashboard'); } else { openPublicPage('signin'); } }}>See your workspace <ArrowRight size={15} /></button></div><div className="audience-grid"><article><span className="audience-number">01</span><Users /><h3>For growing teams</h3><p>Pay people, manage spend and keep financial operations visible as your business scales.</p><a href="#products">Explore business <ArrowRight size={14} /></a></article><article><span className="audience-number">02</span><Sparkles /><h3>For independent minds</h3><p>Get paid, organize your money and take your next opportunity with you.</p><a href="#products">Explore personal <ArrowRight size={14} /></a></article></div></section>
      <section id="why" className="trust-section"><div className="trust-intro"><div className="eyebrow">WHY PAYWAI</div><h2>More visibility.<br /><em>Less uncertainty.</em></h2><p>The best financial tools make the important things easy to see. Every Paywai workflow is designed around clarity, control and confident action.</p></div><div className="trust-grid"><article><ShieldCheck /><b>Security in every step</b><p>Important actions are reviewed before they are authorized.</p></article><article><BarChart3 /><b>One view of your money</b><p>Understand balances, movement and activity without the noise.</p></article><article><Lock /><b>Privacy by design</b><p>Share the context required—not more than you need to.</p></article><article><Globe2 /><b>Ready for anywhere</b><p>Build workflows that match the way modern business moves.</p></article></div></section>
      <section id="resources" className="story-section"><div className="story-card"><div className="eyebrow">A CLEARER WAY TO OPERATE</div><h2>Make every movement<br /><em>count.</em></h2><p>Start with a workspace that puts your priorities first. Connect the rails you trust, set your controls and stay close to what matters.</p><a className="primary" href="/platform">Explore Paywai <ArrowRight size={15} /></a></div><div className="story-side"><div className="mini-stat"><strong>01</strong><span>connected workspace</span></div><div className="mini-stat"><strong>04</strong><span>core money workflows</span></div><div className="mini-stat"><strong>02</strong><span>account paths</span></div></div></section>
      <section className="final"><div><div className="eyebrow">READY WHEN YOU ARE</div><h2>Start moving with <em>more confidence.</em></h2></div><button className="primary large" onClick={() => { setAuthMode('signup'); setPage('auth'); }}>Create your account <ArrowRight size={17} /></button></section>
    </main>
    <footer><button className="logo"><span>P</span>PAYWAI</button><p>Global financial infrastructure for clear, controlled movement.</p><small>Prototype environment · Synthetic data only · © 2026 Paywai</small></footer>
  </div>;
}

function NotFoundPage() {
  return (
    <div className="public-forbidden">
      <div>
        <strong>404</strong>
        <h1>Page not found</h1>
        <p>The requested page does not exist.</p>
        <button className="primary" onClick={() => { window.location.href = '/'; }}>Back to Paywai</button>
      </div>
    </div>
  );
}

function SecretAdminGate() {
  const [status, setStatus] = useState<'checking' | 'password' | 'forbidden' | 'allowed'>('checking');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const checkAccess = async () => {
    const response = await fetch('/api/admin-gate', { credentials: 'include' });
    if (response.status === 403) {
      setStatus('forbidden');
      return;
    }
    if (response.ok) {
      setStatus('allowed');
      return;
    }
    setStatus('password');
  };

  useEffect(() => {
    void checkAccess().catch(() => setStatus('forbidden'));
  }, []);

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin-gate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (!response.ok) {
        setError('Incorrect password.');
        return;
      }
      setPassword('');
      setStatus('allowed');
    } catch {
      setError('Unable to verify access right now.');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'checking') return <div className="demo-loading">Checking private access…</div>;
  if (status === 'forbidden') {
    return (
      <div className="public-forbidden">
        <div>
          <strong>403</strong>
          <h1>Access denied</h1>
          <p>This admin area is restricted to the authorized network.</p>
        </div>
      </div>
    );
  }
  if (status === 'password') {
    return (
      <div className="public-forbidden">
        <div>
          <strong>PRIVATE</strong>
          <h1>Admin authentication</h1>
          <p>Enter the admin password to continue.</p>
          <form onSubmit={submitPassword}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Password"
              aria-label="Admin password"
              required
              style={{ width: '100%', margin: '18px 0 10px', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.06)', color: 'inherit' }}
            />
            {error && <p role="alert">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Enter admin panel'}</button>
          </form>
        </div>
      </div>
    );
  }
  return <AdminPanel onHome={() => { window.location.href = '/'; }} />;
}


function PlatformPage({ onBack, onStart }: { onBack: () => void; onStart: () => void }) {
  return <div className="platform-page"><header className="flow-top"><button className="logo" onClick={onBack}><span>P</span>PAYWAI</button><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back to website</button></header><main><section className="platform-hero"><div className="eyebrow">THE PAYWAI PLATFORM</div><h1>One clear view of <em>every move.</em></h1><p>Payments, cashflow and control—designed together for the way modern businesses and people operate globally.</p><button className="primary large" onClick={onStart}>Create your account <ArrowRight size={16} /></button></section><section className="platform-flow"><div className="flow-intro"><div className="eyebrow">HOW IT WORKS</div><h2>From first payment<br /><em>to next opportunity.</em></h2></div><div className="platform-steps"><article><b>01</b><Globe2 /><h3>Connect globally</h3><p>Bring your trusted payment rails and financial context into one account.</p></article><article><b>02</b><ShieldCheck /><h3>Stay in control</h3><p>Set permissions, review important actions and keep your operation clear.</p></article><article><b>03</b><BarChart3 /><h3>Move forward</h3><p>Understand performance and make the next decision with confidence.</p></article></div></section><section className="platform-banner"><div><div className="eyebrow">BUILT FOR WHAT'S NEXT</div><h2>Financial infrastructure<br /><em>without the friction.</em></h2></div><button className="primary" onClick={onStart}>Get started <ArrowRight size={15} /></button></section></main></div>;
}

export default App;