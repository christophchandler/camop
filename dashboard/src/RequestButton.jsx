export default function RequestButton({ label, requestType, guestId, pendingRequest, sendCommand }) {
  const isPending = pendingRequest && pendingRequest.requestType === requestType;

  const handleClick = () => {
    if (isPending) {
      sendCommand('producer:cancel-request', { guestId });
    } else {
      sendCommand('producer:request', { guestId, requestType });
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all duration-300 ${
        isPending
          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20'
          : 'bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      {isPending ? (
        <span className="flex items-center gap-1.5">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Cancel
        </span>
      ) : label}
    </button>
  );
}
