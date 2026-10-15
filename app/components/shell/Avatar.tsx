import styles from "./Avatar.module.css";

/** Deterministic hue per name, so the same colleague always gets the same colour. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({
  name,
  size = 28,
  title,
}: {
  name: string;
  size?: number;
  title?: string;
}) {
  const h = hue(name);
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 45% 88%)`, color: `hsl(${h} 45% 28%)` }}
      title={title ?? name}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}
