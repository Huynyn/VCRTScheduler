import logoUrl from '../../assets/vcrt-logo-transparent.png';

export default function Header() {
  return (
    <header className="bg-white border-b border-gray-200 shadow-sm no-print">
      <div className="h-1.5 bg-garnet-500" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
        <img
          src={logoUrl}
          alt="VCRT — ÉBIC crest"
          className="h-12 w-12 object-contain shrink-0"
        />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-secondary-700 leading-tight">
            VCRT Shift Scheduler
          </h1>
          <p className="text-sm text-gray-500 leading-tight truncate">
            University of Ottawa — Volunteer Crisis Response Team
          </p>
        </div>
        <div className="ml-auto hidden sm:flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-garnet-500/10 text-garnet-600 text-xs font-semibold">
            Weekly Schedule
          </span>
        </div>
      </div>
    </header>
  );
}
