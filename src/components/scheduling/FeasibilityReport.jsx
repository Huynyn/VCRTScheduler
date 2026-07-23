import { XCircle, AlertTriangle } from 'lucide-react';

export default function FeasibilityReport({ errors = [], warnings = [] }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div className="space-y-3">
      {errors.length > 0 && (
        <div className="alert-error">
          <div className="flex items-center gap-2 font-semibold mb-2">
            <XCircle size={18} /> No valid schedule is possible
          </div>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="alert-warning">
          <div className="flex items-center gap-2 font-semibold mb-2">
            <AlertTriangle size={18} /> Things to watch
          </div>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
