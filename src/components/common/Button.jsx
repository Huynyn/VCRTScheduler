// Maps a `variant` prop to the button classes defined in index.css.
const VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  success: 'btn-success',
  warning: 'btn-warning',
  danger: 'btn-danger',
  outline: 'btn-outline',
  ghost: 'btn-ghost',
};

export default function Button({ variant = 'primary', className = '', children, ...props }) {
  return (
    <button className={`${VARIANTS[variant] || VARIANTS.primary} ${className}`} {...props}>
      {children}
    </button>
  );
}
