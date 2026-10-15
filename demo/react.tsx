import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';

type Status = 'Healthy' | 'Watch' | 'At risk';
interface Account { id: string; name: string; plan: 'Starter' | 'Team' | 'Enterprise'; mrr: number; seats: number; health: number; status: Status; owner: string; renewal: string; ticket: string }

const months = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const revenue = [128, 134, 139, 137, 146, 151, 158, 163, 167, 172, 179, 185];
const movement = months.slice(-6).map((month, index) => ({ month, added: [14, 18, 12, 21, 17, 24][index]!, churned: [6, 9, 5, 7, 8, 6][index]! }));
const planMix = [{ label: 'Enterprise', value: 54, color: '#14171c' }, { label: 'Team', value: 38, color: '#1f6f5c' }, { label: 'Starter', value: 8, color: '#9fcdbd' }];

const names = ['Copperline', 'Northfield', 'Ostrava Labs', 'Brightwater', 'Kestrel Bank', 'Marlow & Finch', 'Tidewell', 'Arcadia Freight', 'Larkspur Health', 'Quillon', 'Redfern Studio', 'Saltmarsh', 'Thornbury', 'Umber Supply', 'Vesta Retail', 'Wexford Legal', 'Yarrow Foods', 'Zephyr Mobility', 'Alder & Co', 'Bramble Games', 'Cinder Works', 'Dovetail HR', 'Elmstead', 'Foxglove Travel'];
const owners = ['Maya Chen', 'Luis Ortega', 'Priya Nair', 'Tom Becker'];
const accounts: Account[] = names.map((name, index) => {
  const health = 38 + ((index * 37) % 61);
  const plan = (['Enterprise', 'Team', 'Team', 'Starter'] as const)[index % 4]!;
  return {
    id: `ACC-${1040 + index}`, name, plan, health,
    mrr: plan === 'Enterprise' ? 9800 + index * 410 : plan === 'Team' ? 1400 + index * 95 : 240 + index * 12,
    seats: plan === 'Enterprise' ? 180 + index * 7 : plan === 'Team' ? 24 + index : 3,
    status: health >= 75 ? 'Healthy' : health >= 55 ? 'Watch' : 'At risk',
    owner: owners[index % owners.length]!, renewal: `2027-${String((index % 12) + 1).padStart(2, '0')}-15`, ticket: `SUP-${3100 + index * 3}`,
  };
});
const money = (value: number) => `$${value.toLocaleString('en-US')}`;

function Sidebar() {
  const items = ['Overview', 'Revenue', 'Customers', 'Forecasts', 'Alerts', 'Reports'];
  return (
    <aside className="sidebar">
      <a className="logo" href="/"><span>H</span>Halden</a>
      <nav aria-label="Workspace">
        {items.map((item) => <a key={item} href="#" className={item === 'Overview' ? 'active' : undefined} aria-current={item === 'Overview' ? 'page' : undefined}>{item}</a>)}
      </nav>
      <div className="workspace"><small>Workspace</small><strong>Copperline Finance</strong></div>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="topbar">
      <label className="search"><span className="sr-only">Search</span><input type="search" placeholder="Search accounts, metrics or reports" /></label>
      <select aria-label="Date range" defaultValue="12m"><option value="30d">Last 30 days</option><option value="12m">Last 12 months</option><option value="ytd">Year to date</option></select>
      <button type="button" className="ghost">Export</button>
      <span className="avatar" aria-label="Maya Chen" role="img">MC</span>
    </header>
  );
}

function KpiCard({ label, value, change, tone = 'up' }: { label: string; value: string; change: string; tone?: 'up' | 'down' }) {
  return (
    <article className="card kpi" data-feature="kpi">
      <p>{label}</p>
      <strong>{value}</strong>
      <span className={`delta ${tone}`}>{change}</span>
    </article>
  );
}

function PurchaseButton({ id }: { id: string }) {
  const [count, setCount] = useState(0);
  return (
    <button id={id} data-testid="purchase" onClick={() => setCount(count + 1)} style={{ padding: 20, margin: 10 }}>
      Add seats · {count}
    </button>
  );
}

function ProductCard() {
  return (
    <section className="card plan" aria-label="Plan usage" data-feature="billing">
      <p className="eyebrow">Team plan · renews Mar 15</p>
      <h2>182 of 200 seats used</h2>
      <div className="meter" role="meter" aria-valuenow={91} aria-valuemin={0} aria-valuemax={100} aria-label="Seat usage"><span style={{ width: '91%' }} /></div>
      <PurchaseButton id="purchase-one" /><PurchaseButton id="purchase-two" />
    </section>
  );
}

function LineChart() {
  const [hover, setHover] = useState<number | null>(null);
  const width = 480, height = 220, pad = 28, min = 120, max = 190;
  const x = (index: number) => pad + (index * (width - pad * 2)) / (revenue.length - 1);
  const y = (value: number) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const line = revenue.map((value, index) => `${index ? 'L' : 'M'}${x(index)} ${y(value)}`).join(' ');
  return (
    <figure className="card chart" data-feature="mrr-trend">
      <figcaption><span>Monthly recurring revenue</span><strong>{money(revenue.at(-1)! * 1000)}</strong></figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly recurring revenue for the last twelve months"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); const index = Math.round(((event.clientX - box.left) / box.width * width - pad) / ((width - pad * 2) / (revenue.length - 1))); setHover(Math.max(0, Math.min(revenue.length - 1, index))); }}>
        {[130, 150, 170, 190].map((value) => <g key={value}><line x1={pad} x2={width - pad} y1={y(value)} y2={y(value)} className="grid" /><text x={0} y={y(value) + 4} className="axis">{value}k</text></g>)}
        <path d={`${line} L${x(revenue.length - 1)} ${height - pad} L${x(0)} ${height - pad} Z`} className="area" />
        <path d={line} className="line" />
        {months.map((month, index) => index % 3 === 0 && <text key={month} x={x(index)} y={height - 6} textAnchor="middle" className="axis">{month}</text>)}
        {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={pad} y2={height - pad} className="cursor" /><circle cx={x(hover)} cy={y(revenue[hover]!)} r={5} className="dot" />
          <g transform={`translate(${Math.min(x(hover) + 10, width - 120)} ${pad})`}><rect width={110} height={42} rx={8} className="tip" /><text x={10} y={17} className="tip-label">{months[hover]}</text><text x={10} y={33} className="tip-value">{money(revenue[hover]! * 1000)}</text></g></g>}
      </svg>
    </figure>
  );
}

function BarChart() {
  const height = 180, max = 26;
  return (
    <figure className="card chart" data-feature="account-movement">
      <figcaption><span>New vs. churned accounts</span><span className="legend"><i className="added" />New<i className="churned" />Churned</span></figcaption>
      <svg viewBox="0 0 320 200" role="img" aria-label="New and churned accounts per month">
        {movement.map((item, index) => {
          const base = 20 + index * 50;
          return <g key={item.month}>
            <rect x={base} y={height - (item.added / max) * 150} width={16} height={(item.added / max) * 150} rx={3} className="bar-added" />
            <rect x={base + 19} y={height - (item.churned / max) * 150} width={16} height={(item.churned / max) * 150} rx={3} className="bar-churned" />
            <text x={base + 17} y={196} textAnchor="middle" className="axis">{item.month}</text>
          </g>;
        })}
      </svg>
    </figure>
  );
}

function DonutChart() {
  const radius = 54, circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <figure className="card chart donut" data-feature="plan-mix">
      <figcaption><span>Revenue by plan</span></figcaption>
      <div className="donut-body">
        <svg viewBox="0 0 140 140" role="img" aria-label="Revenue share by plan">
          {planMix.map((slice) => { const length = (slice.value / 100) * circumference; const element = <circle key={slice.label} cx={70} cy={70} r={radius} fill="none" stroke={slice.color} strokeWidth={18} strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />; offset += length; return element; })}
          <text x={70} y={68} textAnchor="middle" className="donut-total">$185k</text><text x={70} y={86} textAnchor="middle" className="axis">MRR</text>
        </svg>
        <ul>{planMix.map((slice) => <li key={slice.label}><i style={{ background: slice.color }} />{slice.label}<b>{slice.value}%</b></li>)}</ul>
      </div>
    </figure>
  );
}

type SortKey = 'name' | 'plan' | 'mrr' | 'seats' | 'health' | 'renewal';
function AccountsGrid() {
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: 'mrr', direction: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const rows = useMemo(() => [...accounts].sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.direction), [sort]);
  const visible = rows.slice(page * pageSize, page * pageSize + pageSize);
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const header = (key: SortKey, label: string, numeric = false) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'} className={numeric ? 'numeric' : undefined}>
      <button type="button" onClick={() => setSort((current) => ({ key, direction: current.key === key ? (current.direction === 1 ? -1 : 1) : 1 }))}>{label}{sort.key === key ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''}</button>
    </th>
  );
  return (
    <section className="card grid-card" aria-label="Accounts" data-feature="accounts-grid">
      <div className="grid-toolbar">
        <h2>Accounts</h2>
        <span className="muted">{selected.size ? `${selected.size} selected` : `${accounts.length} accounts`}</span>
        <button type="button" className="ghost" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>
      <div className="grid-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="check"><input type="checkbox" aria-label="Select all on this page" checked={visible.every((row) => selected.has(row.id))} onChange={(event) => setSelected((current) => { const next = new Set(current); visible.forEach((row) => event.target.checked ? next.add(row.id) : next.delete(row.id)); return next; })} /></th>
              {header('name', 'Account')}{header('plan', 'Plan')}{header('mrr', 'MRR', true)}{header('seats', 'Seats', true)}{header('health', 'Health', true)}
              <th scope="col">Status</th><th scope="col">Owner</th>{header('renewal', 'Renewal')}<th scope="col">Open ticket</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} data-ticket={row.ticket} aria-selected={selected.has(row.id)}>
                <td className="check"><input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
                <td><strong>{row.name}</strong><small>{row.id}</small></td>
                <td>{row.plan}</td>
                <td className="numeric">{money(row.mrr)}</td>
                <td className="numeric">{row.seats}</td>
                <td className="numeric"><span className="health"><span style={{ width: `${row.health}%` }} /></span>{row.health}</td>
                <td><span className={`pill ${row.status === 'Healthy' ? 'ok' : row.status === 'Watch' ? 'warn' : 'risk'}`}>{row.status}</span></td>
                <td>{row.owner}</td>
                <td>{row.renewal}</td>
                <td><a href="#">{row.ticket}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span className="muted">Showing {page * pageSize + 1}–{Math.min(rows.length, page * pageSize + pageSize)} of {rows.length}</span>
        <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <button type="button" className="ghost" disabled={(page + 1) * pageSize >= rows.length} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  );
}

const tabs = ['Overview', 'Revenue', 'Customers'] as const;
function App() {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Overview');
  return (
    <div className="shell">
      <Sidebar />
      <div className="content">
        <Topbar />
        <main>
          <div className="page-head">
            <div><h1>Overview</h1><p className="muted">Updated 4 minutes ago · All figures in USD</p></div>
            <div role="tablist" aria-label="Dashboard views" className="tabs">
              {tabs.map((name) => <button key={name} role="tab" id={`tab-${name.toLowerCase()}`} aria-controls={`panel-${name.toLowerCase()}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}>{name}</button>)}
            </div>
          </div>
          <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" hidden={tab !== 'Overview'} className="panel">
            <div className="kpis">
              <KpiCard label="MRR" value="$184,920" change="+6.4% vs last month" />
              <KpiCard label="Net revenue retention" value="112%" change="+2.1 pt" />
              <KpiCard label="Logo churn" value="1.8%" change="+0.3 pt" tone="down" />
              <ProductCard />
            </div>
            <div className="charts"><LineChart /><BarChart /><DonutChart /></div>
            <AccountsGrid />
          </div>
          <div role="tabpanel" id="panel-revenue" aria-labelledby="tab-revenue" hidden={tab !== 'Revenue'} className="panel">
            <div className="charts wide"><LineChart /><DonutChart /></div>
          </div>
          <div role="tabpanel" id="panel-customers" aria-labelledby="tab-customers" hidden={tab !== 'Customers'} className="panel">
            <BarChart />
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
