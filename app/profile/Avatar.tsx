import { initialsOf } from "./social";

interface AvatarProps {
  /** JPEG data URL from the profile photos; without one, initials (or a person glyph) on yellow. */
  src?: string;
  name: string;
  /** Empty when the avatar is decorative (the name or a link label is right next to it). */
  alt?: string;
  className?: string;
}

/** Round profile photo, or initials on yellow. Size, border and font come from `className`. */
export function Avatar({ src, name, alt = "", className }: AvatarProps) {
  if (src) {
    // A local data URL: next/image would add nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={src} alt={alt} width={256} height={256} decoding="async" />;
  }
  const initials = initialsOf(name);
  return (
    <span className={className} aria-hidden="true">
      {initials || (
        <svg viewBox="0 0 24 24" width="52%" height="52%" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="8.5" r="4" />
          <path d="M4.5 20.5c0-4.1 3.4-6.6 7.5-6.6s7.5 2.5 7.5 6.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
