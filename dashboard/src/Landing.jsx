import { useState } from 'react';

export default function Landing({ onCreateSession }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    await onCreateSession(name.trim());
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
        <div className="animate-slide-up max-w-md mx-auto" style={{ animationDelay: '0.15s', animationFillMode: 'both' }}>
          <div className="glass p-2 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="Name your session..."
              className="flex-1 bg-transparent border-none px-4 py-3 text-white placeholder-gray-500 outline-none text-sm"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="btn-brand text-sm whitespace-nowrap"
            >
              {creating ? (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Creating...
                </span>
              ) : 'Start Session'}
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
      <div className="absolute bottom-6 text-xs text-gray-600 animate-fade-in" style={{ animationDelay: '0.5s', animationFillMode: 'both' }}>
        Built by Christopher & Company
      </div>
    </div>
  );
}
