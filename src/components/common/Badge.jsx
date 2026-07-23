// Small status pill used for roles, language, and hours.
export default function Badge({ children, color = 'gray', className = '' }) {
  const palette = {
    gray: 'bg-gray-100 text-gray-600',
    blue: 'bg-primary-100 text-primary-700',
    green: 'bg-success-100 text-success-700',
    amber: 'bg-warning-100 text-warning-700',
    red: 'bg-danger-100 text-danger-700',
    slate: 'bg-secondary-100 text-secondary-600',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${palette[color]} ${className}`}
    >
      {children}
    </span>
  );
}
