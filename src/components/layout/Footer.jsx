import { MIN_PER_SHIFT, MAX_PER_SHIFT } from '../../constants/schedule.js';

export default function Footer() {
  return (
    <footer className="no-print border-t border-gray-200 mt-12 py-6 text-center text-xs text-gray-400">
      <p>
        Every shift is staffed by {MIN_PER_SHIFT}–{MAX_PER_SHIFT} responders including at least one
        supervisor and one bilingual responder. Standard responders work 12h/week; reduced
        responders work 6h/week.
      </p>
      <p className="mt-1">Data is stored locally in your browser only.</p>
    </footer>
  );
}
