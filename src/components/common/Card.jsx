// Thin wrappers around the .card classes from index.css so layout stays tidy.
export function Card({ children, className = '' }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions }) {
  return (
    <div className="card-header flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold text-secondary-700">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className = '' }) {
  return <div className={`card-body ${className}`}>{children}</div>;
}
