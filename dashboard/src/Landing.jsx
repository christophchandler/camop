import { useState } from 'react';

// Mirrors server/project.js so the producer sees the folder before creating it.
function yymmdd() {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
  return `${p.year.slice(2)}${p.month}${p.day}`;
}
function squash(text, max = 40) {
  return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9&-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, max);
}
function cleanFolder(text) {
  return String(text || '').trim().replace(/[\/\\:*?"<>|]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120);
}

const field = 'w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white placeholder-gray-500 outline-none focus:border-brand-500/50 text-sm';

export default function Landing({ onCreateSession }) {
  const [client, setClient] = useState('');
  const [project, setProject] = useState('');
  const [useExisting, setUseExisting] = useState(false);
  const [folder, setFolder] = useState('');
  const [brief, setBrief] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const existing = useExisting ? cleanFolder(folder) : '';
  const autoFolder = [yymmdd(), squash(client), squash(project)].filter(Boolean).join('_');
  const target = existing || (squash(client) ? autoFolder : '');
  const canCreate = Boolean(target) && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true); setError('');
    const err = await onCreateSession({ client: client.trim(), project: project.trim(), folder: existing, brief: brief.trim() });
    if (err) setError(err);
    setCreating(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Gradient orbs */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-brand-500/10 rounded-full blur-[120px] animate-float" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-brand-600/8 rounded-full blur-[120px] animate-float" style={{ animationDelay: '-3s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-500/[0.03] rounded-full blur-[100px]" />
        {/* Grid pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '64px 64px'
        }} />
      </div>

      {/* Content */}
      <div className="relative z-10 text-center px-6 max-w-2xl mx-auto">
        {/* Logo */}
        <div className="mb-8 animate-fade-in">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium tracking-wide mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
            RECORDING MADE SIMPLE
          </div>
          <h1 className="text-6xl sm:text-7xl font-extrabold tracking-tight mb-4">
            <span className="text-gradient">CamOp</span>
          </h1>
          <p className="text-lg sm:text-xl text-gray-400 font-light leading-relaxed text-balance max-w-lg mx-auto">
            Drop a link in any meeting chat. Your guest clicks it.
            Studio-quality recording starts instantly.
          </p>
        </div>

        {/* Create Session */}
        <div className="animate-slide-up max-w-md mx-auto text-left" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>
          <div className="glass p-5 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={client} onChange={e => setClient(e.target.value)} placeholder="Client" aria-label="Client" className={field} autoFocus />
              <input type="text" value={project} onChange={e => setProject(e.target.value)} placeholder="Project" aria-label="Project"
                onKeyDown={e => e.key === 'Enter' && handleCreate()} className={field} />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={useExisting} onChange={e => setUseExisting(e.target.checked)} />
              Add to a project folder that's already on the server
            </label>
            {useExisting && (
              <input type="text" value={folder} onChange={e => setFolder(e.target.value)} placeholder="Folder name, e.g. 261008_BonsaiRobotics_RFM"
                aria-label="Existing project folder" className={`${field} font-mono`} />
            )}
            <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={2} placeholder="Brief (optional): who, what it's for, the questions"
              aria-label="Brief" className={`${field} resize-none`} />
            <div className="text-[11px] text-gray-500 font-mono break-all min-h-[1rem]">
              {target ? <>Saves to Projects/<span className="text-gray-300">{target}</span>/2_FOOTAGE/1_VIDEO/CAMOP</> : 'Enter a client to see where the files go'}
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button onClick={handleCreate} disabled={!canCreate} className="btn-brand text-sm w-full py-3">
              {creating ? 'Creating...' : 'Start Session'}
            </button>
          </div>
        </div>

        {/* Features */}
        <div className="mt-16 grid grid-cols-3 gap-6 animate-slide-up" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
          {[
            { icon: '🔗', title: 'Magic Link', desc: 'One link. Any meeting platform.' },
            { icon: '🎬', title: '1080p Recording', desc: 'Local capture at studio quality.' },
            { icon: '☁️', title: 'Auto Upload', desc: 'Files land in the cloud instantly.' },
          ].map((f, i) => (
            <div key={i} className="glass-hover p-5 text-center group cursor-default">
              <div className="text-2xl mb-3 group-hover:scale-110 transition-transform duration-300">{f.icon}</div>
              <div className="text-sm font-semibold text-white mb-1">{f.title}</div>
              <div className="text-xs text-gray-500">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <a href="https://christopherandcompany.tv" target="_blank" rel="noopener noreferrer"
        className="relative z-10 mt-14 mb-24 opacity-60 hover:opacity-100 transition-opacity animate-fade-in"
        style={{ animationDelay: '0.5s', animationFillMode: 'both' }} aria-label="Christopher & Company">
        <img src="/cc-logo-white.svg" alt="Christopher & Company" className="h-6 w-auto" />
      </a>
    </div>
  );
}
